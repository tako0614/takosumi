import { expect, test } from "bun:test";

import { applyStripeBillingEvent } from "../../../../accounts/service/src/billing-apply.ts";
import {
  type AccountsStore,
  type BillingAccountRecord,
  InMemoryAccountsStore,
} from "../../../../accounts/service/src/store.ts";

test("applyStripeBillingEvent invoice.paid clears dunning state after payment_failed", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_checkout",
      type: "checkout.session.completed",
      object: {
        customer: "cus_pay_recovery",
        subscription: "sub_pay",
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_account" },
      },
    }),
  });

  await applyStripeBillingEvent({
    store,
    now: 3000,
    event: stripeEvent({
      id: "evt_failed",
      type: "invoice.payment_failed",
      object: {
        id: "in_pay_failed",
        customer: "cus_pay_recovery",
        next_payment_attempt: 1_700_300_000,
        attempt_count: 2,
      },
    }),
  });

  const afterFailed =
    store.findBillingAccountByStripeCustomerId("cus_pay_recovery");
  expect(afterFailed?.status).toEqual("past_due");
  expect(afterFailed?.dunningStartedAt).toEqual(3000);
  expect(afterFailed?.nextPaymentAttemptUnix).toEqual(1_700_300_000);
  expect(afterFailed?.dunningAttemptCount).toEqual(2);
  expect(afterFailed?.dunningAction).toEqual("retry_scheduled");

  await applyStripeBillingEvent({
    store,
    now: 4000,
    event: stripeEvent({
      id: "evt_paid_recovery",
      type: "invoice.paid",
      object: {
        id: "in_paid",
        customer: "cus_pay_recovery",
        lines: { data: [{ period: { end: 1_700_500_000 } }] },
      },
    }),
  });

  const afterPaid =
    store.findBillingAccountByStripeCustomerId("cus_pay_recovery");
  // invoice_paid must restore active status and clear all dunning fields.
  expect(afterPaid?.status).toEqual("active");
  expect(afterPaid?.dunningStartedAt).toEqual(undefined);
  expect(afterPaid?.nextPaymentAttemptUnix).toEqual(undefined);
  expect(afterPaid?.dunningAttemptCount).toEqual(undefined);
  expect(afterPaid?.dunningAction).toEqual(undefined);
  expect(afterPaid?.currentPeriodEndUnix).toEqual(1_700_500_000);
  expect(afterPaid?.lastInvoiceId).toEqual("in_paid");
});

test("applyStripeBillingEvent rejects checkout missing subject or customer", async () => {
  const store = new InMemoryAccountsStore();

  const noSubject = await applyStripeBillingEvent({
    store,
    event: stripeEvent({
      id: "evt_no_subject",
      type: "checkout.session.completed",
      object: {
        customer: "cus_x",
        payment_status: "paid",
        // metadata.takosumi_subject missing entirely
        metadata: {},
      },
    }),
  });
  expect(noSubject.applied).toEqual(false);
  if (!noSubject.applied) {
    expect(noSubject.reason).toEqual("missing_checkout_owner");
  }

  const noCustomer = await applyStripeBillingEvent({
    store,
    event: stripeEvent({
      id: "evt_no_customer",
      type: "checkout.session.completed",
      object: {
        // customer missing
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_account" },
      },
    }),
  });
  expect(noCustomer.applied).toEqual(false);
  if (!noCustomer.applied) {
    expect(noCustomer.reason).toEqual("missing_checkout_owner");
  }
});

test("applyStripeBillingEvent rejects non-checkout events for unknown Stripe customers", async () => {
  const store = new InMemoryAccountsStore();
  // No checkout has been recorded, so any customer-keyed event must be rejected.

  const failed = await applyStripeBillingEvent({
    store,
    event: stripeEvent({
      id: "evt_phantom_failed",
      type: "invoice.payment_failed",
      object: {
        id: "in_phantom",
        customer: "cus_never_seen",
        attempt_count: 1,
      },
    }),
  });
  expect(failed.applied).toEqual(false);
  if (!failed.applied) expect(failed.reason).toEqual("unknown_customer");

  const updated = await applyStripeBillingEvent({
    store,
    event: stripeEvent({
      id: "evt_phantom_update",
      type: "customer.subscription.updated",
      object: {
        customer: "cus_never_seen",
        status: "active",
      },
    }),
  });
  expect(updated.applied).toEqual(false);
  if (!updated.applied) expect(updated.reason).toEqual("unknown_customer");
});

test("applyStripeBillingEvent treats checkout without payment status or subscription as incomplete", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  const result = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_pending",
      type: "checkout.session.completed",
      object: {
        customer: "cus_pending",
        // no subscription, no payment_status
        metadata: { takosumi_subject: "tsub_account" },
      },
    }),
  });
  expect(result.applied).toEqual(true);
  if (result.applied) {
    expect(result.billingAccount.status).toEqual("incomplete");
  }
});

test("applyStripeBillingEvent serializes concurrent different events without losing field updates (G15)", async () => {
  // A store that interleaves the first conditional save: the first
  // `saveBillingAccountIfVersion` call yields to an injected callback (which
  // applies a SECOND, different webhook event for the same customer) before
  // performing the real CAS. That advances the row's version, so the first
  // apply's CAS misses and the read -> mutate -> conditional-save retry loop
  // must re-read the now-mutated record and re-apply its own mutation. The
  // assertion is that neither writer clobbers the other's distinct fields.
  const backing = new InMemoryAccountsStore();
  let interleave: (() => Promise<void>) | undefined;
  const store: AccountsStore = new Proxy(backing, {
    get(target, property, receiver) {
      if (property === "saveBillingAccountIfVersion") {
        return async (
          record: BillingAccountRecord,
          expectedVersion: number,
        ): Promise<boolean> => {
          const hook = interleave;
          if (hook) {
            interleave = undefined;
            await hook();
          }
          return target.saveBillingAccountIfVersion(record, expectedVersion);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const onFirstConditionalSave = (hook: () => Promise<void>): void => {
    interleave = hook;
  };

  store.saveAccount({
    subject: "tsub_concurrent",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_checkout",
      type: "checkout.session.completed",
      object: {
        customer: "cus_concurrent",
        subscription: "sub_concurrent",
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_concurrent" },
      },
    }),
  });

  // When the dunning (payment_failed) apply reaches its first conditional
  // save, run a credit (refund) apply to completion first. The credit apply
  // touches disjoint fields (lastCredit*) and bumps the version, forcing the
  // dunning apply to retry against the freshly credited record.
  onFirstConditionalSave(async () => {
    await applyStripeBillingEvent({
      store,
      now: 3100,
      event: stripeEvent({
        id: "evt_credit",
        type: "charge.refunded",
        object: {
          id: "re_concurrent",
          customer: "cus_concurrent",
          amount_refunded: 500,
          currency: "usd",
        },
      }),
    });
  });

  const dunning = await applyStripeBillingEvent({
    store,
    now: 3000,
    event: stripeEvent({
      id: "evt_failed",
      type: "invoice.payment_failed",
      object: {
        id: "in_concurrent",
        customer: "cus_concurrent",
        next_payment_attempt: 1_700_300_000,
        attempt_count: 1,
      },
    }),
  });

  expect(dunning.applied).toEqual(true);

  const stored =
    await store.findBillingAccountByStripeCustomerId("cus_concurrent");
  // The dunning apply's fields survived its retry against the credited row.
  expect(stored?.status).toEqual("past_due");
  expect(stored?.dunningAction).toEqual("retry_scheduled");
  expect(stored?.lastInvoiceId).toEqual("in_concurrent");
  // The credit apply's disjoint fields were NOT clobbered (the lost-update
  // bug this guards against).
  expect(stored?.lastCreditId).toEqual("re_concurrent");
  expect(stored?.lastCreditAmount).toEqual(500);
  expect(stored?.lastCreditCurrency).toEqual("usd");
});

test("applyStripeBillingEvent resolves a realistic dispute (no top-level customer) and freezes entitlements", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_dispute",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
  });

  let resolvedWith: { chargeId?: string; paymentIntentId?: string } | null =
    null;
  const result = await applyStripeBillingEvent({
    store,
    now: 2000,
    // Real Stripe dispute payload: NO top-level `customer`, `charge` /
    // `payment_intent` are unexpanded string ids.
    event: stripeEvent({
      id: "evt_dispute_real",
      type: "charge.dispute.created",
      object: {
        id: "dp_real",
        charge: "ch_real",
        payment_intent: "pi_real",
        reason: "fraudulent",
        status: "needs_response",
        created: 1_700_001_000,
      },
    }),
    resolveDisputeCustomerId: (input) => {
      resolvedWith = {
        chargeId: input.chargeId,
        paymentIntentId: input.paymentIntentId,
      };
      return "cus_dispute";
    },
  });

  expect(result.applied).toEqual(true);
  expect(resolvedWith).toEqual({
    chargeId: "ch_real",
    paymentIntentId: "pi_real",
  });
  const account = store.findBillingAccountByStripeCustomerId("cus_dispute");
  expect(account?.status).toEqual("disputed");
  expect(account?.preDisputeStatus).toEqual("active");
  expect(account?.activeDispute?.disputeId).toEqual("dp_real");
});

test("applyStripeBillingEvent fails closed when a dispute owner cannot be resolved", async () => {
  const store = new InMemoryAccountsStore();
  const result = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_dispute_unlinked",
      type: "charge.dispute.created",
      object: {
        id: "dp_unlinked",
        charge: "ch_unknown",
        status: "needs_response",
        created: 1_700_001_000,
      },
    }),
    // Resolver cannot link the charge to a customer.
    resolveDisputeCustomerId: () => undefined,
  });

  // Must NOT be silently dropped: a non-`unhandled_event` reason records the
  // webhook as `failed` so Stripe retries the chargeback.
  expect(!result.applied).toBeTruthy();
  expect(result.reason).toEqual("unresolved_dispute_customer");
});

test("applyStripeBillingEvent skips an unknown subscription status without suspending", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_unknown_status",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
  });

  const result = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_unknown_status",
      type: "customer.subscription.updated",
      object: {
        customer: "cus_unknown_status",
        status: "some_future_status",
      },
    }),
  });

  // Unknown status is treated as no-op (skipped), NOT coerced into a
  // suspend-worthy `incomplete`.
  expect(!result.applied).toBeTruthy();
  expect(result.reason).toEqual("unhandled_event");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_unknown_status")?.status,
  ).toEqual("active");
});

test("applyStripeBillingEvent subscription_updated recovery clears stale dunning state", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_account",
    provider: "stripe",
    stripeCustomerId: "cus_recover",
    status: "past_due",
    dunningStartedAt: 1500,
    nextPaymentAttemptUnix: 1_700_300_000,
    dunningAttemptCount: 2,
    dunningAction: "retry_scheduled",
    createdAt: 1000,
    updatedAt: 1500,
  });

  const result = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_recover",
      type: "customer.subscription.updated",
      object: {
        customer: "cus_recover",
        status: "active",
      },
    }),
  });

  expect(result.applied).toEqual(true);
  const account = store.findBillingAccountByStripeCustomerId("cus_recover");
  // Recovery to active must clear stale dunning metadata so the account does
  // not show `active` alongside `retry_scheduled`.
  expect(account?.status).toEqual("active");
  expect(account?.dunningStartedAt).toEqual(undefined);
  expect(account?.nextPaymentAttemptUnix).toEqual(undefined);
  expect(account?.dunningAttemptCount).toEqual(undefined);
  expect(account?.dunningAction).toEqual(undefined);
});

test("applyStripeBillingEvent create path returns version 1 and a deterministic id", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_account",
    email: "user@example.test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  const result = await applyStripeBillingEvent({
    store,
    now: 2000,
    event: stripeEvent({
      id: "evt_checkout",
      type: "checkout.session.completed",
      object: {
        customer: "cus_create",
        subscription: "sub_create",
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_account" },
      },
    }),
  });

  expect(result.applied).toBeTruthy();
  // Create returns the persisted version (1), matching the stored record and
  // the update branch (which returns expectedVersion + 1).
  expect(result.billingAccount.version).toEqual(1);
  const stored = store.findBillingAccountForSubject("tsub_account");
  expect(stored?.version).toEqual(1);
  expect(stored?.billingAccountId).toEqual(
    result.billingAccount.billingAccountId,
  );

  // A second checkout for the SAME subject must not orphan a duplicate
  // account: the deterministic, subject-derived id keeps it on one row and
  // takes the update path.
  const second = await applyStripeBillingEvent({
    store,
    now: 3000,
    event: stripeEvent({
      id: "evt_checkout_2",
      type: "checkout.session.completed",
      object: {
        customer: "cus_create_2",
        subscription: "sub_create_2",
        payment_status: "paid",
        metadata: { takosumi_subject: "tsub_account" },
      },
    }),
  });
  expect(second.applied).toBeTruthy();
  expect(second.billingAccount.billingAccountId).toEqual(
    result.billingAccount.billingAccountId,
  );
  expect(second.billingAccount.version).toEqual(2);
});

function stripeEvent(input: {
  id: string;
  type: string;
  object: unknown;
  previousAttributes?: unknown;
}) {
  return {
    id: input.id,
    type: input.type,
    data: {
      object: input.object,
      ...(input.previousAttributes === undefined
        ? {}
        : { previous_attributes: input.previousAttributes }),
    },
  };
}
