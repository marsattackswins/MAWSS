import { formatPrice } from "@/lib/maws/feed";
import { formatTicker } from "@/lib/maws/universe";
import { useAppStore } from "@/lib/store";
import { playAlertSound } from "@/lib/trading/sounds";
import type { AlertHit, PriceAlert } from "@/types";

/**
 * alerts/fire.ts — what happens when a price alert fires: a history entry, a
 * sound, and (when the user switched it on and the browser allows it) a desktop
 * notification so the alert reaches you while another tab is in front.
 */

/** Older browsers and server rendering have no Notification at all. */
export function desktopNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function alertNotificationsGranted(): boolean {
  if (!desktopNotificationsSupported()) return false;
  try {
    return Notification.permission === "granted";
  } catch {
    return false;
  }
}

/** Ask the browser for notification permission. Must run from a click/keypress. */
export async function requestAlertNotifications(): Promise<boolean> {
  if (!desktopNotificationsSupported()) return false;
  try {
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Switch desktop alerts on/off. Turning them on asks for permission first and
 *  leaves the switch off when the browser refuses. */
export async function setDesktopAlertsEnabled(on: boolean): Promise<void> {
  const store = useAppStore.getState();
  if (!on) {
    store.patchChartSettings({ alertDesktop: false });
    return;
  }
  const granted = await requestAlertNotifications();
  store.patchChartSettings({ alertDesktop: granted });
}

function describe(alert: PriceAlert, last: number): string {
  const direction = alert.side === "above" ? "above" : "below";
  return `${formatTicker(alert.symbol)} crossed ${direction} ${formatPrice(
    alert.symbol,
    alert.price,
  )} — now ${formatPrice(alert.symbol, last)}`;
}

function showDesktopNotification(alert: PriceAlert, last: number): void {
  try {
    const note = new Notification("MAWS price alert", {
      body: describe(alert, last),
      tag: alert.id, // one live notification per alert, replacements rather than a stack
      silent: true, // the app plays its own alert sound
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    /* notifications can throw where the platform blocks them — the sound and the
     * history entry already happened, so a missing popup is not worth an error */
  }
}

/** Record the hit, sound it, and notify. Returns the history entry it wrote. */
export function fireAlert(alert: PriceAlert, last: number, at: number): AlertHit {
  const store = useAppStore.getState();
  const hit: AlertHit = {
    id: `${alert.id}:${at}`,
    alertId: alert.id,
    symbol: alert.symbol,
    price: alert.price,
    side: alert.side,
    last,
    at,
  };
  store.recordAlertHit(hit);
  playAlertSound();
  if (store.chartSettings.alertDesktop === true && alertNotificationsGranted()) {
    showDesktopNotification(alert, last);
  }
  return hit;
}
