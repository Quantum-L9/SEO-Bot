/* L9_META
 * layer: test
 * role: test_fixture
 * status: active
 */

/**
 * A deterministic stand-in for a model that follows the PROMPT's output
 * contract literally. It never sees the zod schema: every structural value it
 * returns is synthesized from the rendered `output_contract` text in the user
 * prompt, so a reply that fails validation means the prompt and the schema
 * disagree — exactly the drift that used to cost a repair call per run.
 *
 * The only things taken from elsewhere in the prompt are the semantic
 * instructions a compliant model obeys (route identities, the global intent
 * plan, valid internal-link targets, no gaps without market research).
 */

/**
 * Prefix of every string placeholder in a rendered contract. A faithful model
 * writes content only over these; every other value is copied verbatim.
 */
const PLACEHOLDER = "string";

/**
 * Synthesize a reply from a rendered output shape the way a model that copies
 * the contract would: structure, booleans, numbers and every exact value
 * (enum options, discriminators) are copied VERBATIM; only string
 * placeholders are written over, with `seed` text. It never translates
 * descriptive text into a value. A contract that describes a value instead of
 * showing it therefore fails here exactly as it fails a real model.
 */
export function exampleFromOutputShape(shape: unknown, seed = "example"): unknown {
  if (Array.isArray(shape)) {
    return shape.map((element) => exampleFromOutputShape(element, seed));
  }
  if (shape !== null && typeof shape === "object") {
    return Object.fromEntries(
      Object.entries(shape).map(([key, child]) => [
        key,
        exampleFromOutputShape(child, `${seed}-${key}`),
      ]),
    );
  }
  if (typeof shape === "string" && shape.startsWith(PLACEHOLDER)) return seed;
  return shape;
}

interface IntentEntry {
  route_id: string;
  primary_query: string;
  primary_intent: string;
  journey_stage: string;
}

type RouteRef = { route_id: string; path: string };

/** Answer one blueprint prompt (Phase A or a Phase B batch) from its output contract. */
export function answerBlueprintPrompt(userPrompt: string): Record<string, unknown> {
  const prompt = JSON.parse(userPrompt) as {
    task: string;
    routes?: RouteRef[];
    market?: { market_research?: string };
    all_route_index?: RouteRef[];
    current_batch?: RouteRef[];
    global_route_intent_plan?: IntentEntry[];
    output_contract: {
      shape?: { routes: [unknown] };
      container?: Record<string, unknown>;
      route_shape?: unknown;
    };
  };

  if (prompt.task === "global_route_intent_plan") {
    const shape = prompt.output_contract.shape!;
    return {
      ...(exampleFromOutputShape(shape) as Record<string, unknown>),
      routes: prompt.routes!.map((route) => ({
        ...(exampleFromOutputShape(shape.routes[0], route.route_id) as Record<string, unknown>),
        route_id: route.route_id,
        primary_query: `primary query for ${route.path}`,
      })),
    };
  }

  if (prompt.task !== "seo_content_blueprint_batch") {
    throw new Error(`unexpected blueprint task: ${prompt.task}`);
  }
  const contract = prompt.output_contract;
  const containerKeys = Object.keys(contract.container!);
  if (containerKeys.length !== 1 || containerKeys[0] !== "routes") {
    throw new Error(`unexpected batch container keys: ${containerKeys.join(",")}`);
  }
  const intents = new Map(prompt.global_route_intent_plan!.map((i) => [i.route_id, i]));
  const firstParty = prompt.market?.market_research === "not_requested";
  const routes = prompt.current_batch!.map((route) => {
    const intent = intents.get(route.route_id)!;
    const example = exampleFromOutputShape(contract.route_shape, route.route_id) as Record<
      string,
      Record<string, unknown> & unknown[]
    >;
    const linkTarget = prompt.all_route_index!.find((r) => r.route_id !== route.route_id);
    return {
      ...example,
      route_id: route.route_id,
      path: route.path,
      search_intent: {
        ...example.search_intent,
        primary: intent.primary_intent,
        journey_stage: intent.journey_stage,
      },
      targets: { ...example.targets, primary_query: intent.primary_query },
      competitive_gaps: firstParty ? [] : example.competitive_gaps,
      internal_links: linkTarget
        ? (example.internal_links as Array<Record<string, unknown>>).map((link) => ({
            ...link,
            target_route_id: linkTarget.route_id,
          }))
        : [],
    };
  });
  return { routes };
}
