import { useState, type InputHTMLAttributes } from "react";
import { Check, ChevronDown, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Segmented, type SegmentedProps } from "antd";
import { Select, Slider, Switch } from "radix-ui";
import "./SettingsControls.css";

export interface SettingsSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function SettingsInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`cy-control-input ${props.className ?? ""}`.trim()} />;
}

export function SettingsPasswordInput({
  showLabel,
  hideLabel,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { showLabel: string; hideLabel: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="cy-control-password">
      <SettingsInput {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="cy-control-password__toggle"
        aria-label={visible ? hideLabel : showLabel}
        title={visible ? hideLabel : showLabel}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </span>
  );
}

export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
  className,
}: {
  value: T;
  options: SettingsSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger id={id} className={`cy-control-select ${className ?? ""}`.trim()} aria-label={ariaLabel} disabled={disabled}>
        <Select.Value />
        <Select.Icon className="cy-control-select__icon"><ChevronDown size={15} aria-hidden="true" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="cy-control-select__content" position="item-aligned">
          <Select.Viewport className="cy-control-select__viewport">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="cy-control-select__item"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="cy-control-select__check"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function SettingsSlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  onChange,
  onChangeComplete,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onChange: (value: number) => void;
  onChangeComplete?: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <Slider.Root
      className="cy-control-slider"
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next) => { if (next[0] !== undefined) onChange(next[0]); }}
      onValueCommit={(next) => { if (next[0] !== undefined) onChangeComplete?.(next[0]); }}
    >
      <Slider.Track className="cy-control-slider__track"><Slider.Range className="cy-control-slider__range" /></Slider.Track>
      <Slider.Thumb className="cy-control-slider__thumb" aria-label={ariaLabel} aria-valuetext={`${value}`} />
    </Slider.Root>
  );
}

export function SettingsSwitch({
  checked,
  ariaLabel,
  onChange,
  disabled = false,
  loading = false,
}: {
  checked: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Switch.Root className="cy-control-switch" checked={checked} onCheckedChange={onChange} aria-label={ariaLabel} aria-busy={loading || undefined} disabled={disabled || loading}>
      <Switch.Thumb className="cy-control-switch__thumb">
        {loading && <LoaderCircle className="cy-control-switch__loading" size={12} aria-hidden="true" />}
      </Switch.Thumb>
    </Switch.Root>
  );
}

export function SettingsSegmented<ValueType = string>(props: SegmentedProps<ValueType>) {
  return <Segmented {...props} shape="round" className={`cy-control-segmented ${props.className ?? ""}`.trim()} />;
}
