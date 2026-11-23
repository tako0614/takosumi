import { afterEach, expect, test } from "bun:test";
import {
  useConfirmDialog,
  useConfirmDialogActions,
  useConfirmDialogState,
} from "../../../../dashboard/src/lib/confirm-dialog.ts";

const { confirm } = useConfirmDialog();
const { handleCancel, handleConfirm } = useConfirmDialogActions();
const state = useConfirmDialogState();

afterEach(handleCancel);

test("retiring a confirmation closes its dialog and resolves without consent", async () => {
  const owner = new AbortController();
  const result = confirm({ title: "Review", message: "Confirm the selected app", signal: owner.signal });
  expect(state().isOpen).toBe(true);
  owner.abort();
  expect(await result).toBe(false);
  expect(state().isOpen).toBe(false);
});

test("retiring an earlier confirmation does not close the current dialog", async () => {
  const owner = new AbortController();
  const earlier = confirm({ title: "Earlier review", message: "First app", signal: owner.signal });
  const current = confirm({ title: "Current review", message: "Second app" });
  owner.abort();
  expect(await earlier).toBe(false);
  expect(state().title).toBe("Current review");
  handleConfirm();
  expect(await current).toBe(true);
});
