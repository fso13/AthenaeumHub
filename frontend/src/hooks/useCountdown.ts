import { useEffect, useState } from 'react';

/** Seconds until `until` (epoch ms). Ticks once per second while active. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    if (until <= Date.now()) return;

    const interval = setInterval(() => {
      setNow(Date.now());
      if (until <= Date.now()) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [until]);

  if (!until) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}
