const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface NewYorkSessionTime {
  sessionKey: string;
  minuteOfDay: number;
  weekday: string;
}

export function newYorkSessionTime(epochSeconds: number): NewYorkSessionTime {
  const parts = Object.fromEntries(newYorkClock.formatToParts(new Date(epochSeconds * 1000)).map((part) => [part.type, part.value]));
  return {
    sessionKey: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday,
  };
}

export function isNyRegularMarketHours(epochSeconds: number): boolean {
  const time = newYorkSessionTime(epochSeconds);
  if (time.weekday === "Sat" || time.weekday === "Sun") return false;
  return time.minuteOfDay >= 9 * 60 + 30 && time.minuteOfDay < 16 * 60;
}
