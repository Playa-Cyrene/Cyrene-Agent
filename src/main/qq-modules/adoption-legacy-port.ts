import type { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import type { QqAdoptionProofPorts } from "./adoption-proof";

/** Real current-host routing boundary only; never proof of historical orphans.
 * All callers must use this router, not keep a bypass reference to legacy.start. */
export function createQqCurrentHostLegacyAdoptionPort(
  router: QqRoutingAdapter,
  expectedIdentity: { accountId: string; connectionEpoch: number },
): NonNullable<QqAdoptionProofPorts["legacy"]> {
  const expected = { ...expectedIdentity };
  if (!/^\d+$/.test(expected.accountId) || !Number.isSafeInteger(expected.connectionEpoch) || expected.connectionEpoch < 0) throw new Error("QQ_ADOPTION_IDENTITY_REQUIRED");
  let attempted = false;
  return {
    async stopAndDrain(context) {
      if (attempted || context.mode !== "validated-upgrade") return false;
      attempted = true;
      const current = router.getMigrationIdentity();
      if (router.getDriver() !== "legacy" || !current || current.accountId !== expected.accountId || current.connectionEpoch !== expected.connectionEpoch) return false;
      const result = await router.prepareMigrationStop(expected);
      return result.safeToSwitch === true && result.drained === true && result.stopped === true && router.getDriver() === "blocked";
    },
  };
}
