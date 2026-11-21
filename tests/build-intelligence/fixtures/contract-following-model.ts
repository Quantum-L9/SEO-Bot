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

const SEPARATOR = " — ";

/** Synthesize a value that satisfies a rendered output shape. */
export function exampleFromOutputShape(shape: unknown, seed = "example"): unknown {
  if (Array.isArray(shape)) {
    if (shape.length !== 1) throw new Error("rendered array shapes carry exactly one element");
    return [exampleFromOutputShape(shape[0], seed)];
  }
  if (shape !== null && typeof shape === "object") {
    return Object.fromEntries(
      Object.entries(shape).map(([key, child]) => [
        key,
        exampleFromOutputShape(child, `${seed}-${key}`),
      ]),
    );
  }
  if (typeof shape !== "string") throw new Error(`unexpected shape node: ${String(shape)}`);
  const type = shape.split(SEPARATOR)[0]!.replace(/ \(optional\)$/, "");
  if (type === "string") return seed;
  if (type === "string[]") return [seed];
  if (type === "boolean") return true;
  if (type === "number") return 1;
  if (type.startsWith("one of: ")) return type.slice("one of: ".length).split(" | ")[0];
  const arrayOf = /^array of \((.+)\)$/.exec(type);
  if (arrayOf) return [arrayOf[1]!.split(" | ")[0]];
  throw new Error(`unrecognized rendered leaf type: "${type}"`);
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
