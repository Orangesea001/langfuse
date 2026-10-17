import {
  AliasNode,
  CommonTableExpressionNameNode,
  CommonTableExpressionNode,
  Kysely,
  TableNode,
  WithNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type RootOperationNode,
  type SelectQueryBuilder,
  type SelectQueryNode,
} from "kysely";

import type { ClickhouseCompilable } from "./compile";
import { AnalyticsCompileDialect } from "./dialect";
import { AnalyticsOperationNodeTransformer } from "./transformer";

export type AnalyticsView<N extends string, O> = {
  name: N;
  build: () => ClickhouseCompilable;
  /** Phantom: the view's exposed row type. */
  readonly $row?: O;
};

/**
 * Name a compilable query as a black-box relation. The outer query can only
 * see `O` (the view's selected columns), never the inner physical schema.
 * Implemented as a plugin that rewrites `selectFrom(viewName)` into a WITH CTE;
 * tenancy injection still walks the CTE body.
 */
export function defineView<N extends string>(name: N) {
  return <O>(build: () => ClickhouseCompilable): AnalyticsView<N, O> => ({
    name,
    build,
  });
}

class VirtualViewPlugin implements KyselyPlugin {
  private readonly views: Map<string, AnalyticsView<string, unknown>>;

  constructor(
    views: AnalyticsView<string, unknown> | AnalyticsView<string, unknown>[],
  ) {
    const list = Array.isArray(views) ? views : [views];
    this.views = new Map(list.map((view) => [view.name, view]));
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    if (args.node.kind !== "SelectQueryNode") return args.node;
    const transformer = new AnalyticsOperationNodeTransformer();
    const node = transformer.transformNode(args.node) as SelectQueryNode;

    const froms = node.from?.froms ?? [];
    const viewNames = froms
      .map(tableNameOfFrom)
      .filter((name): name is string => Boolean(name && this.views.has(name)));

    if (viewNames.length === 0) return node;

    let withNode = node.with;
    for (const name of viewNames) {
      const def = this.views.get(name)!;
      const inner = def.build().toOperationNode();
      const cte = CommonTableExpressionNode.create(
        CommonTableExpressionNameNode.create(name),
        inner,
      );
      withNode = withNode
        ? WithNode.cloneWithExpression(withNode, cte)
        : WithNode.create(cte);
    }

    return { ...node, with: withNode };
  }

  async transformResult(args: PluginTransformResultArgs) {
    return args.result;
  }
}

function tableNameOfFrom(node: OperationNode): string | undefined {
  if (TableNode.is(node)) {
    return node.table.identifier.name;
  }
  if (AliasNode.is(node)) {
    return tableNameOfFrom(node.node);
  }
  return undefined;
}

/**
 * Open a query against a named view as if it were a table. Only the view's
 * exposed columns are in the type.
 */
export function fromView<N extends string, O>(
  view: AnalyticsView<N, O>,
): SelectQueryBuilder<Record<N, O>, N, Record<string, never>> {
  type DB = Record<N, O>;
  const db = new Kysely<DB>({ dialect: new AnalyticsCompileDialect() });
  return db
    .withPlugin(new VirtualViewPlugin(view as AnalyticsView<string, unknown>))
    .selectFrom(view.name) as SelectQueryBuilder<
    Record<N, O>,
    N,
    Record<string, never>
  >;
}
