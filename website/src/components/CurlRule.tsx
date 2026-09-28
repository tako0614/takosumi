import type { JSX } from "solid-js";

/** The mark's arm, drawn long: a hairline that runs the column width and
 *  ends in the signature spiral curl. Used as the flourish under the hero
 *  actions and again just before the red field footer — the line curls
 *  into the tile. */
export default function CurlRule(): JSX.Element {
  return (
    <div class="container curl-rule-wrap" aria-hidden="true">
      <div class="curl-rule" />
    </div>
  );
}
