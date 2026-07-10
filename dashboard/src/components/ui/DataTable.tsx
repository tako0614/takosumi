import { For, type JSX, Show } from "solid-js";
import { t } from "../../i18n/index.ts";

export interface Column<T> {
  /** Header label. */
  header: JSX.Element;
  /** Cell renderer for a row. */
  cell: (row: T, index: number) => JSX.Element;
  /** Right-align (e.g. row actions / numeric). */
  align?: "left" | "right";
  /** Extra class on the <td>/<th> (e.g. nowrap). */
  class?: string;
}

interface Props<T> {
  columns: readonly Column<T>[];
  rows: readonly T[] | undefined;
  /** Stable key per row. */
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  error?: JSX.Element;
  /** Rendered when rows is empty (and not loading/error). */
  empty?: JSX.Element;
  /** Number of skeleton rows to show while loading. */
  skeletonRows?: number;
  class?: string;
}

/**
 * Generic data table: typed column defs, sticky header, and built-in
 * loading-skeleton / empty / error rows. Behaviour-neutral — the caller still
 * owns the data source.
 */
export default function DataTable<T>(props: Props<T>): JSX.Element {
  const colCount = () => props.columns.length;
  return (
    <div class={`tg-table-wrap ${props.class ?? ""}`}>
      <table class="tg-table">
        <thead>
          <tr>
            <For each={props.columns}>
              {(col) => (
                <th
                  scope="col"
                  class={col.class}
                  style={col.align === "right" ? "text-align:right" : undefined}
                >
                  {col.header}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <Show when={props.error}>
            <tr>
              <td class="tg-table-state" colSpan={colCount()} role="alert">
                {props.error}
              </td>
            </tr>
          </Show>
          <Show when={!props.error && props.loading}>
            <For each={Array.from({ length: props.skeletonRows ?? 3 })}>
              {() => (
                <tr>
                  <For each={props.columns}>
                    {() => (
                      <td>
                        <div class="tg-skel tg-skel-row" aria-hidden="true" />
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </Show>
          <Show
            when={
              !props.error && !props.loading && (props.rows?.length ?? 0) === 0
            }
          >
            <tr>
              <td class="tg-table-state" colSpan={colCount()}>
                {props.empty ?? t("common.empty")}
              </td>
            </tr>
          </Show>
          <Show when={!props.error && !props.loading}>
            <For each={props.rows ?? []}>
              {(row, index) => (
                <tr data-key={props.rowKey(row, index())}>
                  <For each={props.columns}>
                    {(col) => (
                      <td
                        class={col.class}
                        style={
                          col.align === "right" ? "text-align:right" : undefined
                        }
                      >
                        {col.cell(row, index())}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  );
}
