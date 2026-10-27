/**
 * A past moment shown relatively ("3 時間前"), with the exact date and time on
 * hover and in the machine-readable `datetime` attribute.
 */
import { formatDateTime, relativeTime } from "../../../i18n/index.ts";

export default function RelativeTime(props: { readonly iso: string }) {
  return (
    <time datetime={props.iso} title={formatDateTime(props.iso)}>
      {relativeTime(props.iso)}
    </time>
  );
}
