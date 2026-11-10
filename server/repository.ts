import type { EntityKind, EntityMap, Snapshot } from '../shared/types.js';
export type MaybePromise<T> = T | Promise<T>;
export interface Repository {
  readonly source: 'demo' | 'postgres';
  ready(): MaybePromise<void>;
  close(): MaybePromise<void>;
  snapshot(): MaybePromise<Snapshot>;
  publicPreview(): MaybePromise<unknown>;
  create(kind: EntityKind, body: unknown, actor?: string): MaybePromise<EntityMap[EntityKind]>;
  update(kind: EntityKind, id: string, body: unknown, version: number, actor?: string): MaybePromise<EntityMap[EntityKind]>;
  publish(kind: EntityKind, id: string, published: boolean, version: number, actor?: string): MaybePromise<EntityMap[EntityKind]>;
  delete(kind: EntityKind, id: string, version: number, actor?: string): MaybePromise<{deleted: boolean}>;
}
