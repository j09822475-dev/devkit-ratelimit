/**
 * Lua scripts — single-RTT atomic check+decrement, one per algorithm.
 * Re-exported to the Upstash adapter so the algorithmic correctness proof
 * has a single source of truth.
 *
 * Every script returns a 4-tuple:
 *   `{ allowed, remaining, reset_ms, retry_after_ms }`
 *
 * where `allowed` is `1` / `0`, `remaining` is the post-consume count,
 * `reset_ms` is the wall-clock millisecond at which the next permit is
 * available, and `retry_after_ms` is the number of milliseconds the
 * caller should wait before retrying.
 */

/**
 * Script arguments common to every algorithm:
 *   ARGV[1] = `now` (wall-clock ms, supplied by the manager)
 *   ARGV[2] = `cost`
 * Algorithm-specific arguments follow.
 */

/**
 * Fixed-window — `INCRBY` + `PEXPIRE` with computed window expiry.
 *
 * KEYS[1] = base key
 * ARGV[3] = limit
 * ARGV[4] = window_ms
 */
export const FIXED_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local start = now - (now % window)
local reset = start + window
local key = KEYS[1] .. ':' .. start
local count = tonumber(redis.call('GET', key) or '0')
if cost == 0 then
  local remaining = math.max(0, limit - count)
  local allowed = (count < limit) and 1 or 0
  return {allowed, remaining, reset, allowed == 1 and 0 or (reset - now)}
end
if count + cost > limit then
  return {0, math.max(0, limit - count), reset, reset - now}
end
local newCount = redis.call('INCRBY', key, cost)
redis.call('PEXPIRE', key, window + 1000)
return {1, math.max(0, limit - newCount), reset, 0}
`;

/**
 * Sliding-window counter — interpolates between two adjacent fixed
 * windows. Stores `<key>:<start>` and `<key>:<prev_start>`; reads both,
 * computes the approximation, increments the current window's counter on
 * allow.
 *
 * KEYS[1] = base key
 * ARGV[3] = limit
 * ARGV[4] = window_ms
 */
export const SLIDING_WINDOW_COUNTER_LUA = `
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local start = now - (now % window)
local prevStart = start - window
local reset = start + window
local curKey = KEYS[1] .. ':' .. start
local prevKey = KEYS[1] .. ':' .. prevStart
local cur = tonumber(redis.call('GET', curKey) or '0')
local prev = tonumber(redis.call('GET', prevKey) or '0')
local elapsedFrac = (now - start) / window
local approx = math.floor(prev * (1 - elapsedFrac)) + cur
if cost == 0 then
  local remaining = math.max(0, limit - approx)
  local allowed = (approx < limit) and 1 or 0
  return {allowed, remaining, reset, allowed == 1 and 0 or (reset - now)}
end
if approx + cost > limit then
  return {0, math.max(0, limit - approx), reset, reset - now}
end
local newCur = redis.call('INCRBY', curKey, cost)
redis.call('PEXPIRE', curKey, window * 2 + 1000)
local newApprox = math.floor(prev * (1 - elapsedFrac)) + newCur
return {1, math.max(0, limit - newApprox), reset, 0}
`;

/**
 * Sliding-window log — sorted set of timestamps, atomic
 * `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` cycle.
 *
 * KEYS[1] = sorted-set key
 * ARGV[3] = limit
 * ARGV[4] = window_ms
 */
export const SLIDING_WINDOW_LOG_LUA = `
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
local count = tonumber(redis.call('ZCARD', KEYS[1]) or '0')
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local oldestTs = oldest[2] and tonumber(oldest[2]) or now
local reset = oldestTs + window
if cost == 0 then
  local remaining = math.max(0, limit - count)
  local allowed = (count < limit) and 1 or 0
  return {allowed, remaining, reset, allowed == 1 and 0 or (reset - now)}
end
if count + cost > limit then
  return {0, math.max(0, limit - count), reset, reset - now}
end
-- Build a unique-per-call suffix from a server-side counter (INCR is
-- atomic) plus the high-resolution microsecond field of TIME. Cluster
-- replication reseeds Lua's PRNG per-call for determinism, so two
-- concurrent EVAL invocations at the same millisecond CAN draw
-- identical math.random() values and collide on ZADD (the duplicate is
-- then a silent no-op and the bucket undercounts). The seq + microsecond
-- combination cannot collide between concurrent calls.
local seq = redis.call('INCR', KEYS[1] .. ':seq')
redis.call('PEXPIRE', KEYS[1] .. ':seq', window + 1000)
local t = redis.call('TIME')
local micros = t[2]
for i = 1, cost do
  redis.call('ZADD', KEYS[1], now, now .. ':' .. seq .. ':' .. i .. ':' .. micros)
end
redis.call('PEXPIRE', KEYS[1], window + 1000)
return {1, math.max(0, limit - (count + cost)), reset, 0}
`;

/**
 * Token bucket — single hash per key holding `level` and `updatedAt`.
 * Refill is computed continuously; `(elapsed / interval) * refill`.
 *
 * KEYS[1] = hash key
 * ARGV[3] = capacity
 * ARGV[4] = refill
 * ARGV[5] = interval_ms
 */
export const TOKEN_BUCKET_LUA = `
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local refill = tonumber(ARGV[4])
local interval = tonumber(ARGV[5])
local data = redis.call('HMGET', KEYS[1], 'level', 'updatedAt')
local level = tonumber(data[1])
local updatedAt = tonumber(data[2])
if level == nil then level = capacity end
if updatedAt == nil then updatedAt = now end
local elapsed = math.max(0, now - updatedAt)
local refillAmount = (elapsed / interval) * refill
local settled = math.min(capacity, level + refillAmount)
if cost == 0 then
  local remaining = math.floor(settled)
  local wait = 0
  if settled < 1 then
    wait = math.ceil(((1 - settled) / refill) * interval)
  end
  return {1, remaining, now + wait, wait}
end
if settled < cost then
  redis.call('HSET', KEYS[1], 'level', tostring(settled), 'updatedAt', tostring(now))
  redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / refill) * interval) + 1000)
  local deficit = cost - settled
  local wait = math.ceil((deficit / refill) * interval)
  return {0, math.floor(math.max(0, settled)), now + wait, wait}
end
local nextLevel = settled - cost
redis.call('HSET', KEYS[1], 'level', tostring(nextLevel), 'updatedAt', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / refill) * interval) + 1000)
return {1, math.floor(nextLevel), now, 0}
`;

/**
 * Leaky bucket — symmetric with the token-bucket script but adds water
 * instead of removing tokens, with `leak` instead of `refill`.
 *
 * KEYS[1] = hash key
 * ARGV[3] = capacity
 * ARGV[4] = leak
 * ARGV[5] = interval_ms
 */
export const LEAKY_BUCKET_LUA = `
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local leak = tonumber(ARGV[4])
local interval = tonumber(ARGV[5])
local data = redis.call('HMGET', KEYS[1], 'level', 'updatedAt')
local level = tonumber(data[1])
local updatedAt = tonumber(data[2])
if level == nil then level = 0 end
if updatedAt == nil then updatedAt = now end
local elapsed = math.max(0, now - updatedAt)
local leaked = (elapsed / interval) * leak
local settled = math.max(0, level - leaked)
if cost == 0 then
  local remaining = math.floor(math.max(0, capacity - settled))
  return {1, remaining, now, 0}
end
if settled + cost > capacity then
  redis.call('HSET', KEYS[1], 'level', tostring(settled), 'updatedAt', tostring(now))
  redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / leak) * interval) + 1000)
  local overflow = settled + cost - capacity
  local wait = math.ceil((overflow / leak) * interval)
  return {0, math.floor(math.max(0, capacity - settled)), now + wait, wait}
end
local nextLevel = settled + cost
redis.call('HSET', KEYS[1], 'level', tostring(nextLevel), 'updatedAt', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / leak) * interval) + 1000)
return {1, math.floor(math.max(0, capacity - nextLevel)), now + math.ceil((nextLevel / leak) * interval), 0}
`;

/**
 * Map of algorithm kind → Lua script body. Used by the Redis and Upstash
 * adapters to dispatch on `spec.kind` without a switch in the hot path.
 */
export const LUA_SCRIPTS = {
  'fixed-window': FIXED_WINDOW_LUA,
  'sliding-window-counter': SLIDING_WINDOW_COUNTER_LUA,
  'sliding-window-log': SLIDING_WINDOW_LOG_LUA,
  'token-bucket': TOKEN_BUCKET_LUA,
  'leaky-bucket': LEAKY_BUCKET_LUA,
} as const;
