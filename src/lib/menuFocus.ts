export interface TargetContainer<T> {
  contains(target: T): boolean;
}

export function isTargetOutside<T>(container: TargetContainer<T> | null, target: T): boolean {
  return !container?.contains(target);
}
