import { useEffect, useRef } from 'react';

const BAR_COUNT = 28;

/**
 * Live input-level visualisation. Driven by a subscription and DOM writes (not React state)
 * so a 10 Hz meter does not re-render the screen. When `subscribe` is null the bars are idle.
 */
export function LevelBars({ subscribe, active }: { subscribe: ((listener: (level: number) => void) => () => void) | null; active: boolean }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const history = useRef<number[]>(Array.from({ length: BAR_COUNT }, () => 0));

  useEffect(() => {
    if (!subscribe || !active) {
      history.current = history.current.map(() => 0);
      barsRef.current.forEach((bar) => bar && (bar.style.height = '5px'));
      return;
    }
    return subscribe((level) => {
      history.current.push(level);
      history.current.shift();
      history.current.forEach((value, index) => {
        const bar = barsRef.current[index];
        if (bar) bar.style.height = `${Math.max(5, Math.round(value * 56))}px`;
      });
    });
  }, [subscribe, active]);

  return (
    <div className={`level-bars${active ? '' : ' level-bars--idle'}`} role="img" aria-label={active ? 'Live microphone level' : 'Microphone level (not recording)'}>
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          ref={(el) => {
            barsRef.current[index] = el;
          }}
          style={{ height: 5 }}
        />
      ))}
    </div>
  );
}
