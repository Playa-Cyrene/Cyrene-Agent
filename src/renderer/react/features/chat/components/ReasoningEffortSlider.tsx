import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { ReasoningDropdownItem } from "../../../../lib/reasoning-dropdown";
import type { ReasoningEffort, ReasoningPreference } from "../../../../../shared/reasoning";

interface ReasoningEffortSliderProps {
  options: readonly ReasoningDropdownItem[];
  activePreference: ReasoningPreference;
  defaultEffort?: ReasoningEffort;
  active: boolean;
  busy: boolean;
  onSelect: (item: ReasoningDropdownItem) => Promise<boolean>;
}

function samePreference(left: ReasoningPreference, right: ReasoningPreference): boolean {
  return left.mode === right.mode
    && left.effort === right.effort;
}

function drawPixelFlow(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  sweepTravel: number,
  tileTravel: number,
  power: number,
): void {
  context.clearRect(0, 0, width, height);
  if (power <= 0.002) return;

  const coverage = width * power;
  const cell = 4;
  const front = sweepTravel % coverage;
  // Move the grid in whole pixels so each tile stays sharp.
  const tileOffset = Math.floor(tileTravel % cell);
  const tileSteps = Math.floor(tileTravel / cell);
  context.save();
  context.beginPath();
  context.rect(0, 0, coverage, height);
  context.clip();

  for (let x = -cell; x < coverage; x += cell) {
    const drawX = x + tileOffset;
    const sourceX = x - tileSteps * cell;
    const visibleX = Math.max(0, Math.min(coverage, drawX));
    const gradient = visibleX / Math.max(coverage, 1);
    const distance = Math.abs(visibleX - front);
    const sweep = Math.exp(-Math.min(distance, coverage - distance) / 17);
    const column = 0.5 + 0.5 * Math.sin(sourceX * 0.19);
    for (let y = 0; y < height; y += cell) {
      const noise = Math.sin((sourceX + 4) * 12.9898 + (y + 3) * 78.233) * 43758.5453;
      const grain = noise - Math.floor(noise);
      if (grain < 0.14 && sweep < 0.25) continue;

      const vertical = 1 - Math.abs((y + cell / 2) / height * 2 - 1);
      const alpha = Math.min(0.96, (0.43 + grain * 0.17 + column * 0.18 + sweep * 0.3)
        * (0.72 + vertical * 0.28) * (0.78 + power * 0.22));
      const firstHalf = Math.min(1, gradient * 2);
      const secondHalf = Math.max(0, gradient * 2 - 1);
      const red = Math.min(255, Math.round(57 + firstHalf * 180 - secondHalf * 2 + sweep * 45));
      const green = Math.min(255, Math.round(201 - firstHalf * 81 - secondHalf * 64 + sweep * 70));
      const blue = Math.min(255, Math.round(207 - firstHalf * 37 - secondHalf * 41 + sweep * 50));
      context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
      context.fillRect(drawX, y, cell - 1, cell - 1);
    }
  }
  context.restore();
}

function PixelFlow({ power, active }: { power: number; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualPowerRef = useRef(power);
  const motionRef = useRef({ sweep: 0, tiles: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    if (!active) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 1;
    let height = 1;
    let frame = 0;
    let previousTime: number | undefined;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (time: number) => {
      const elapsed = previousTime === undefined ? 0 : Math.min((time - previousTime) / 1000, 0.05);
      previousTime = time;
      visualPowerRef.current += (power - visualPowerRef.current) * 0.16;
      if (Math.abs(power - visualPowerRef.current) < 0.002) visualPowerRef.current = power;
      const animatedPower = visualPowerRef.current;
      if (animatedPower > 0.002) {
        motionRef.current.sweep += elapsed * (18 + 580 * animatedPower * animatedPower);
        motionRef.current.tiles += elapsed * (10 + 90 * animatedPower * animatedPower);
      }
      drawPixelFlow(context, width, height, motionRef.current.sweep, motionRef.current.tiles, animatedPower);
      if (!reducedMotion.matches && (power > 0 || visualPowerRef.current > 0.002)) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    const observer = new ResizeObserver(() => {
      resize();
      if (reducedMotion.matches) {
        visualPowerRef.current = power;
        drawPixelFlow(context, width, height, 0, 0, power);
      }
    });
    observer.observe(canvas);
    resize();
    if (power === 0) {
      visualPowerRef.current = 0;
      motionRef.current = { sweep: 0, tiles: 0 };
    }
    if (reducedMotion.matches) {
      visualPowerRef.current = power;
      drawPixelFlow(context, width, height, 0, 0, power);
    } else {
      frame = window.requestAnimationFrame(draw);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [power, active]);

  return <canvas ref={canvasRef} className="cy-reasoning-slider__pixels" aria-hidden="true" />;
}

export function ReasoningEffortSlider({
  options,
  activePreference,
  defaultEffort,
  active,
  busy,
  onSelect,
}: ReasoningEffortSliderProps) {
  const hasOff = options[0]?.preference.mode === "off";
  const firstRank = hasOff ? 0 : 1;
  const maxRank = options.length - (hasOff ? 1 : 0);
  const activeIndex = options.findIndex((item) => samePreference(item.preference, activePreference));
  const fallbackEffort = activePreference.effort ?? defaultEffort;
  const fallbackIndex = options.findIndex((item) => item.preference.effort === fallbackEffort
    && item.preference.mode === "on");
  const firstOnIndex = options.findIndex((item) => item.preference.mode === "on");
  const visualIndex = activeIndex >= 0 ? activeIndex : (fallbackIndex >= 0 ? fallbackIndex : Math.max(0, firstOnIndex));
  const selectedRank = visualIndex + firstRank;
  const [preview, setPreview] = useState(selectedRank);
  const previewRef = useRef(selectedRank);
  const draggingRef = useRef(false);
  const committingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draggingRef.current || committingRef.current) return;
    previewRef.current = selectedRank;
    setPreview(selectedRank);
  }, [selectedRank]);

  const clampRank = (value: number) => Math.max(firstRank, Math.min(maxRank, value));
  const rankFromPointer = (clientX: number) => {
    const bounds = inputRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return previewRef.current;
    return clampRank((clientX - bounds.left) / bounds.width * maxRank);
  };
  const showPreview = (rank: number) => {
    previewRef.current = rank;
    setPreview(rank);
  };
  const commit = async (raw: number) => {
    if (committingRef.current || busy) return;
    const rank = Math.round(clampRank(raw));
    const item = options[rank - firstRank];
    if (!item || item.disabled) {
      showPreview(selectedRank);
      return;
    }
    showPreview(rank);
    committingRef.current = true;
    try {
      if (!await onSelect(item)) showPreview(selectedRank);
    } finally {
      committingRef.current = false;
    }
  };
  const stopDragging = (event: PointerEvent<HTMLInputElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    draggingRef.current = false;
    const rank = rankFromPointer(event.clientX);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void commit(rank);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const current = Math.round(previewRef.current);
    let target: number | undefined;
    if (["ArrowRight", "ArrowUp", "PageUp"].includes(event.key)) target = current + 1;
    else if (["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) target = current - 1;
    else if (event.key === "Home") target = firstRank;
    else if (event.key === "End") target = maxRank;
    if (target === undefined) return;
    event.preventDefault();
    void commit(clampRank(target));
  };

  const nearestRank = Math.round(clampRank(preview));
  const currentItem = options[nearestRank - firstRank];
  const progress = maxRank > 0 ? preview / maxRank : 0;
  const style = {
    "--cy-reasoning-progress": `${progress * 100}%`,
    "--cy-reasoning-visible": progress > 0 ? 1 : 0,
  } as CSSProperties;

  return (
    <div className="cy-reasoning-slider" style={style}>
      <div className="cy-reasoning-slider__track">
        <PixelFlow power={progress} active={active} />
        <span className="cy-reasoning-slider__flare" aria-hidden="true" />
        <input
          ref={inputRef}
          className="cy-reasoning-slider__input"
          type="range"
          min={firstRank}
          max={maxRank}
          step={0.01}
          value={preview}
          disabled={busy}
          aria-label="推理强度"
          aria-valuetext={currentItem?.label ?? ""}
          onChange={(event) => {
            const next = clampRank(Number(event.currentTarget.value));
            showPreview(next);
            if (!draggingRef.current) void commit(next);
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.focus();
            pointerIdRef.current = event.pointerId;
            draggingRef.current = true;
            showPreview(rankFromPointer(event.clientX));
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (pointerIdRef.current === event.pointerId) showPreview(rankFromPointer(event.clientX));
          }}
          onPointerUp={stopDragging}
          onPointerCancel={(event) => {
            if (pointerIdRef.current !== event.pointerId) return;
            pointerIdRef.current = null;
            draggingRef.current = false;
            showPreview(selectedRank);
          }}
          onLostPointerCapture={() => {
            if (!draggingRef.current) return;
            pointerIdRef.current = null;
            draggingRef.current = false;
            showPreview(selectedRank);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="cy-reasoning-slider__thumb" aria-hidden="true" />
      </div>
      <div className="cy-reasoning-slider__marks">
        {options.map((item, index) => {
          const rank = index + firstRank;
          return (
            <button
              key={`${item.preference.mode}:${item.preference.effort ?? "on"}`}
              type="button"
              className={rank === nearestRank && (activeIndex >= 0 || preview !== selectedRank) ? "is-active" : undefined}
              style={{ left: `${rank / maxRank * 100}%` }}
              disabled={busy || item.disabled}
              onClick={() => void commit(rank)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
