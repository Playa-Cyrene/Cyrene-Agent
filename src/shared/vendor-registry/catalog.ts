import { VENDOR_REGISTRY, type BuiltinProviderId } from "./index";
import type { VendorRegistryEntry } from "./types";

/** 静态推荐目录；不改写名称，不探测接口，每次返回独立数组。 */
export function getBuiltinModels(
  providerId: BuiltinProviderId,
  purpose: "chat" | "vision",
): readonly string[] {
  const entry = (VENDOR_REGISTRY as readonly VendorRegistryEntry[])
    .find((vendor) => vendor.capability.id === providerId);
  return (entry?.models ?? [])
    .filter((item) => item.recommendedFor.includes(purpose))
    .map((item) => item.model);
}
