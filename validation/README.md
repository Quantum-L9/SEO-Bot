# Validation directory

- `policy.yaml`: profile and gate policy, written in JSON-compatible YAML
- `schemas/`: gate evidence, run report, release receipt, and manifest contracts
- `runs/`: generated local or CI evidence, ignored by Git

Run evidence is immutable. Gate logs and textual artifacts are redacted before persistence. Database validation emits a migration receipt; release and production profiles emit a receipt whose passing state requires an image digest. Delete local runs with `npm run evidence:clean`; never edit a result in place.
