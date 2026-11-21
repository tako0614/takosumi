import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import { ExternalLink, Play, Star, X } from "lucide-solid";
import type { TcsLocale } from "../../lib/tcs-aggregate.ts";
import {
  fetchTcsReviewsPage,
  tcsListingPageHref,
  type TcsGalleryItem,
  type TcsListing,
  type TcsLocalizedText,
  type TcsRating,
  type TcsReviewsPage,
} from "../../lib/tcs-client.ts";
import "./StoreListingDetails.css";

const copy = {
  ja: {
    screenshots: "スクリーンショット",
    video: "プレビュー動画",
    close: "閉じる",
    whatsNew: "更新情報",
    reviews: "評価とレビュー",
    emptyRating: "評価なし",
    loading: "読み込み中…",
    failed: "レビューを読み込めませんでした。",
    retry: "再試行",
    more: "レビューをもっと見る",
    write: "レビューを書く",
    save: "あとで見る",
  },
  en: {
    screenshots: "Screenshots",
    video: "Preview video",
    close: "Close",
    whatsNew: "What’s new",
    reviews: "Ratings and reviews",
    emptyRating: "No ratings",
    loading: "Loading…",
    failed: "Reviews couldn’t be loaded.",
    retry: "Retry",
    more: "More reviews",
    write: "Write a review",
    save: "Save for later",
  },
} as const;

function display(text: TcsLocalizedText | undefined, locale: TcsLocale) {
  return text?.[locale]?.trim() || text?.en?.trim() || text?.ja?.trim();
}

const score = (value: number, locale: TcsLocale) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);

export function StoreRating(props: {
  readonly rating?: TcsRating;
  readonly locale: TcsLocale;
  readonly showEmpty?: boolean;
}) {
  const labels = () => copy[props.locale];
  return (
    <Show when={props.rating}>
      {(rating) => (
        <Show when={rating().count > 0} fallback={
          <Show when={props.showEmpty}><span class="tcs-product-rating">{labels().emptyRating}</span></Show>
        }>
          <span class="tcs-product-rating" data-testid="store-rating">
            <Star size={14} fill="currentColor" aria-hidden="true" />
            <span>{score(rating().average, props.locale)} / 5</span>
            <span>({new Intl.NumberFormat(props.locale).format(rating().count)})</span>
          </span>
        </Show>
      )}
    </Show>
  );
}

export function StoreGallery(props: {
  readonly gallery?: readonly TcsGalleryItem[];
  readonly appName: string;
  readonly locale: TcsLocale;
}) {
  const titleId = createUniqueId();
  let dialog: HTMLDialogElement | undefined;
  const [selected, setSelected] = createSignal<TcsGalleryItem>();
  const labels = () => copy[props.locale];
  const assetLabel = (item: TcsGalleryItem, index: number) =>
    display(item.alt, props.locale) ||
      (item.kind === "video"
        ? labels().video
        : `${props.appName} · ${labels().screenshots} ${index + 1}`);
  const open = (item: TcsGalleryItem) => {
    setSelected(item);
    dialog?.showModal();
  };
  return (
    <Show when={props.gallery && props.gallery.length > 0}>
      <section class="tcs-product-section tcs-product-gallery" aria-label={labels().screenshots}>
        <ul class="tcs-product-media">
          <For each={props.gallery}>
            {(item, index) => (
              <li>
                <button type="button" aria-label={assetLabel(item, index())} onClick={() => open(item)}>
                  <Show when={item.kind === "image"} fallback={
                    <span class="tcs-product-video-tile"><Play size={24} aria-hidden="true" />{labels().video}</span>
                  }>
                    <img
                      src={item.url}
                      alt=""
                      width={item.width}
                      height={item.height}
                      loading="lazy"
                      decoding="async"
                      crossorigin="anonymous"
                      referrerpolicy="no-referrer"
                    />
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
        <dialog
          ref={dialog}
          class="tcs-product-media-dialog"
          aria-labelledby={titleId}
          onClose={() => setSelected(undefined)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation();
          }}
        >
          <header>
            <h3 id={titleId}>{selected()?.kind === "video" ? labels().video : labels().screenshots}</h3>
            <button type="button" aria-label={labels().close} onClick={() => dialog?.close()}>
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <Show when={selected()} keyed>
            {(item) => (
              <Show when={item.kind === "image"} fallback={
                <video
                  src={item.url}
                  width={item.width}
                  height={item.height}
                  controls
                  playsinline
                  preload="none"
                  crossorigin="anonymous"
                  aria-label={assetLabel(item, 0)}
                />
              }>
                <img
                  src={item.url}
                  alt={assetLabel(item, props.gallery?.indexOf(item) ?? 0)}
                  width={item.width}
                  height={item.height}
                  decoding="async"
                  crossorigin="anonymous"
                  referrerpolicy="no-referrer"
                />
              </Show>
            )}
          </Show>
        </dialog>
      </section>
    </Show>
  );
}

function formatReviewDate(value: string, locale: TcsLocale): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date) : undefined;
}

export function StoreOfferDetails(props: {
  readonly listing: TcsListing;
  readonly locale: TcsLocale;
}) {
  const labels = () => copy[props.locale];
  const href = (section: "reviews" | "save") => props.listing.primaryServer
    ? tcsListingPageHref(props.listing.primaryServer, props.listing.id, section)
    : undefined;
  const [reviews, setReviews] = createSignal<TcsReviewsPage | null>();
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let pending: AbortController | undefined;
  onCleanup(() => pending?.abort());

  async function load(cursor?: string) {
    pending?.abort();
    const { primaryServer, id } = props.listing;
    if (!primaryServer) return;
    const request = new AbortController();
    pending = request;
    setLoading(true);
    setFailed(false);
    try {
      const page = await fetchTcsReviewsPage(primaryServer, id, {
        cursor,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
      });
      if (!request.signal.aborted) {
        setReviews((current) => page && cursor && current
          ? { ...page, items: [...current.items, ...page.items] }
          : page);
      }
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  createEffect(on(
    () => JSON.stringify([props.listing.primaryServer, props.listing.id]),
    () => {
      setReviews(undefined);
      void load();
    },
  ));

  return (
    <div class="tcs-product-details">
      <Show when={display(props.listing.releaseNotes, props.locale)}>
        {(notes) => (
          <section class="tcs-product-section">
            <h2>{labels().whatsNew}</h2>
            <p>{notes()}</p>
          </section>
        )}
      </Show>
      <Show when={reviews() !== null || props.listing.rating}>
        <section class="tcs-product-section tcs-product-reviews">
          <h2>{labels().reviews}</h2>
          <Show when={props.listing.rating}>
            <StoreRating rating={props.listing.rating} locale={props.locale} showEmpty />
          </Show>
          <Show when={reviews()}>
            {(page) => (
              <Show when={page().items.length > 0}>
                <ul class="tcs-product-review-list">
                  <For each={page().items}>
                    {(review) => (
                      <li>
                        <p>
                          <strong>{review.author}</strong>
                          <span class="tcs-product-rating"><Star size={13} fill="currentColor" aria-hidden="true" />{review.stars} / 5</span>
                          <Show when={formatReviewDate(review.updatedAt, props.locale)}>
                            {(date) => <time dateTime={review.updatedAt}>{date()}</time>}
                          </Show>
                        </p>
                        <Show when={review.text}>{(message) => <p>{message()}</p>}</Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Show>
          <Show when={loading()}><p role="status" class="tcs-product-muted">{labels().loading}</p></Show>
          <Show when={failed()}>
            <p role="status" class="tcs-product-muted">{labels().failed}</p>
          </Show>
          <Show when={reviews()?.nextCursor || failed()}>
            <button class="tcs-product-aux" type="button" disabled={loading()} onClick={() => void load(reviews()?.nextCursor)}>
              {failed() ? labels().retry : labels().more}
            </button>
          </Show>
          <Show when={reviews() || props.listing.rating}>
            <div class="tcs-product-review-actions">
              <Show when={href("reviews")}>
                {(url) => <a class="tcs-product-aux" href={url()} target="_blank" rel="noopener noreferrer">{labels().write}<ExternalLink size={14} aria-hidden="true" /></a>}
              </Show>
              <Show when={href("save")}>
                {(url) => <a class="tcs-product-aux" href={url()} target="_blank" rel="noopener noreferrer">{labels().save}<ExternalLink size={14} aria-hidden="true" /></a>}
              </Show>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  );
}
