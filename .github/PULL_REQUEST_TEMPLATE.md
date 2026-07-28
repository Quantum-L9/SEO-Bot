<!-- l9-pr-template: v1 -->

## Summary

<!-- What does this PR change and why? One or two sentences. -->

## Change classification

<!-- The PR Pipeline classifier routes gates from changed files. Add namespaced
     labels as hints (evidence still beats labels). See
     .github/governance/label-taxonomy.yaml -->

- [ ] `type:*` label applied (feature / bug / refactor / docs / ci / security / test / deps / governance)
- [ ] `area:*` label applied where relevant
- [ ] `risk:*` label applied if this touches a security/contract/deploy boundary

## Verification

<!-- State what you ran and the result. If you could NOT verify, say so plainly. -->

- [ ] `npm run lint`
- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run`

## Risk / rollback

<!-- Blast radius, and how to revert if this misbehaves. -->

## Checklist

- [ ] No secrets, tokens, or credentials added to the diff
- [ ] Contract/schema changes are accompanied by the corresponding contract update
- [ ] Docs updated if behavior changed
