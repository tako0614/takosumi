/**
 * Barrel for the hand-rolled Takosumi dashboard UI component library.
 *
 * Takosumi dashboard design system, zero headless-UI deps, lucide-solid icons. The
 * shared component CSS lives in src/styles/components.css (the `tg-*` classes).
 */

export { default as Button } from "./Button.tsx";
export { Card, CardHeader, CardSection } from "./Card.tsx";
export { Badge, StatusBadge, type Tone } from "./Badge.tsx";
export { Checkbox, FormField, Input, Select, Textarea } from "./Form.tsx";
export { default as PageHeader } from "./PageHeader.tsx";
export { default as EmptyState } from "./EmptyState.tsx";
export { default as Skeleton } from "./Skeleton.tsx";
export { default as Spinner } from "./Spinner.tsx";
export { default as KVList, type KVItem } from "./KVList.tsx";
export { default as Toast } from "./Toast.tsx";
export { default as Tabs, type TabItem } from "./Tabs.tsx";
export { default as DataTable, type Column } from "./DataTable.tsx";
