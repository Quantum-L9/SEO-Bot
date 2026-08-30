import type { WebsiteFactoryHandoffV3 } from "./handoff.js";

export interface SeoBotProbe {
  name: string;
  ok: true;
  detail?: string;
}

export interface SeoBotRegistrationAck {
  schema: "seo-bot.website-factory-registration-ack/v1";
  registered: true;
  maintenance_ready: true;
  client_id: string;
  contract_id: string;
  contract_digest: string;
  release_receipt_id: string;
  verified_repository: string;
  verified_branch: string;
  verified_commit_sha: string;
  probes: SeoBotProbe[];
  acknowledged_at: string;
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;

export function buildSeoBotRegistrationAck(
  contract: WebsiteFactoryHandoffV3,
  probes: SeoBotProbe[],
  acknowledgedAt = new Date().toISOString(),
): SeoBotRegistrationAck {
  const ack: SeoBotRegistrationAck = {
    schema: "seo-bot.website-factory-registration-ack/v1",
    registered: true,
    maintenance_ready: true,
    client_id: contract.client.id,
    contract_id: contract.contract_id,
    contract_digest: contract.integrity.payload_digest,
    release_receipt_id: contract.proof.receipt_id,
    verified_repository: contract.site.repository.full_name,
    verified_branch: contract.site.repository.branch,
    verified_commit_sha: contract.site.repository.commit_sha,
    probes,
    acknowledged_at: acknowledgedAt,
  };
  validateSeoBotRegistrationAck(ack);
  return ack;
}

export function validateSeoBotRegistrationAck(
  value: unknown,
): asserts value is SeoBotRegistrationAck {
  if (!value || typeof value !== "object")
    throw new Error("registration acknowledgement must be an object");
  const ack = value as Partial<SeoBotRegistrationAck>;
  if (
    ack.schema !== "seo-bot.website-factory-registration-ack/v1" ||
    ack.registered !== true ||
    ack.maintenance_ready !== true ||
    !ack.client_id ||
    !ack.contract_id ||
    !ack.release_receipt_id ||
    !ack.verified_repository ||
    !ack.verified_branch
  ) {
    throw new Error("registration acknowledgement identity is invalid");
  }
  if (!SHA64.test(String(ack.contract_digest)) || !SHA40.test(String(ack.verified_commit_sha))) {
    throw new Error("registration acknowledgement proof is invalid");
  }
  if (Number.isNaN(Date.parse(String(ack.acknowledged_at))))
    throw new Error("registration acknowledgement timestamp is invalid");
  if (
    !Array.isArray(ack.probes) ||
    ack.probes.length < 4 ||
    ack.probes.some((probe) => probe.ok !== true || !probe.name?.trim())
  ) {
    throw new Error("registration acknowledgement probes are incomplete");
  }
  const probeNames = new Set(ack.probes.map((probe) => probe.name));
  if (probeNames.size !== ack.probes.length)
    throw new Error("registration acknowledgement probes must be unique");
}
