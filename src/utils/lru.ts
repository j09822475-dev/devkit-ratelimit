/**
 * Tiny doubly-linked LRU used by the in-memory store. Supports O(1)
 * insert / get / evict. Deliberately minimal — no size functions, no
 * dispose hooks, no async fetch.
 */

interface LruNode<K, V> {
  key: K;
  value: V;
  prev: LruNode<K, V> | null;
  next: LruNode<K, V> | null;
}

/**
 * Bounded LRU cache. Inserting beyond `maxSize` evicts the
 * least-recently-touched entry.
 *
 * @typeParam K Key type.
 * @typeParam V Value type.
 */
export class Lru<K, V> {
  private readonly map: Map<K, LruNode<K, V>>;
  private head: LruNode<K, V> | null;
  private tail: LruNode<K, V> | null;

  /**
   * @param maxSize Maximum number of entries. MUST be a positive integer.
   */
  constructor(private readonly maxSize: number) {
    this.map = new Map();
    this.head = null;
    this.tail = null;
  }

  /**
   * @returns The current number of entries.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Look up a value, promoting it to the MRU position.
   *
   * @param key Key to look up.
   * @returns   The associated value, or `undefined`.
   */
  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (node === undefined) return undefined;
    this.touch(node);
    return node.value;
  }

  /**
   * Look up a value WITHOUT promoting it to the MRU position. Use this
   * for read-only inspection (e.g. the memory store's `peek`) so an idle
   * key being polled doesn't artificially keep itself alive and evict
   * actually-active keys.
   *
   * @param key Key to look up.
   * @returns   The associated value, or `undefined`.
   */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /**
   * Insert or update a value. Updating refreshes its MRU position.
   * Inserting beyond `maxSize` evicts the LRU entry.
   *
   * @param key   Key to set.
   * @param value Value to associate.
   */
  set(key: K, value: V): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      this.touch(existing);
      return;
    }
    const node: LruNode<K, V> = { key, value, prev: null, next: this.head };
    if (this.head !== null) this.head.prev = node;
    this.head = node;
    if (this.tail === null) this.tail = node;
    this.map.set(key, node);
    if (this.map.size > this.maxSize) this.evictTail();
  }

  /**
   * Remove a key.
   *
   * @param key Key to remove.
   * @returns   `true` iff the key existed.
   */
  delete(key: K): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    this.unlink(node);
    this.map.delete(key);
    return true;
  }

  /**
   * Test for key presence without promoting.
   *
   * @param key Key to test.
   * @returns   `true` iff the key exists.
   */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Iterate every entry in MRU-first order.
   *
   * @returns A generator of `[key, value]` pairs.
   */
  *entries(): Generator<[K, V]> {
    let node = this.head;
    while (node !== null) {
      yield [node.key, node.value];
      node = node.next;
    }
  }

  /**
   * Drop every entry.
   */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  private touch(node: LruNode<K, V>): void {
    if (node === this.head) return;
    this.unlink(node);
    node.prev = null;
    node.next = this.head;
    if (this.head !== null) this.head.prev = node;
    this.head = node;
    if (this.tail === null) this.tail = node;
  }

  private unlink(node: LruNode<K, V>): void {
    if (node.prev !== null) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next !== null) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private evictTail(): void {
    if (this.tail === null) return;
    this.map.delete(this.tail.key);
    const newTail = this.tail.prev;
    if (newTail !== null) newTail.next = null;
    else this.head = null;
    this.tail = newTail;
  }
}
