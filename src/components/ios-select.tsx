"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

export type IosSelectOption = {
  disabled?: boolean;
  label: string;
  value: string;
};

type IosSelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children" | "className" | "defaultValue" | "value"
> & {
  className?: string;
  defaultValue?: string;
  leadingIcon?: ReactNode;
  options: IosSelectOption[];
  value?: string;
  variant?: "field" | "pill" | "scope" | "compact" | "inline";
};

const subscribe = () => () => {};
const needsFallback = () => !CSS.supports("appearance", "base-select");
const serverFallback = () => false;

export function IosSelect({
  className,
  defaultValue,
  disabled,
  id: suppliedId,
  leadingIcon,
  onChange,
  options,
  value,
  variant = "field",
  ...props
}: IosSelectProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const pickerId = `${id}-picker`;
  const fallback = useSyncExternalStore(subscribe, needsFallback, serverFallback);
  const selectRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const initialValue = value ?? defaultValue ?? options[0]?.value ?? "";
  const [currentValue, setCurrentValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedValue = value ?? currentValue;
  const selectedLabel = options.find((option) => option.value === selectedValue)?.label ?? options[0]?.label ?? "";
  const classNames = [
    "ios-select",
    variant !== "field" ? `ios-select--${variant}` : "",
    leadingIcon ? "ios-select--with-leading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  function closePicker() {
    pickerRef.current?.hidePopover();
    setOpen(false);
  }

  useEffect(() => {
    const select = selectRef.current;
    const form = select?.form;
    function reset() {
      queueMicrotask(() => {
        if (select?.isConnected) setCurrentValue(select.value);
        setInvalid(false);
        pickerRef.current?.hidePopover();
      });
    }
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  useEffect(() => {
    if (!open) return;
    const picker = pickerRef.current;
    if (disabled) picker?.hidePopover();
    function dismiss(event: Event) {
      if (!(event.target instanceof Node) || !picker?.contains(event.target)) picker?.hidePopover();
    }
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    window.visualViewport?.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      window.visualViewport?.removeEventListener("resize", dismiss);
    };
  }, [disabled, open]);

  useEffect(() => {
    if (open) document.getElementById(`${pickerId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, pickerId]);

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    setCurrentValue(event.target.value);
    setInvalid(false);
    onChange?.(event);
  }

  function openPicker(index = options.findIndex((option) => option.value === selectedValue && !option.disabled)) {
    const trigger = triggerRef.current;
    const picker = pickerRef.current;
    if (!trigger || !picker || trigger.matches(":disabled")) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const below = top + height - rect.bottom - 12;
    const above = rect.top - top - 12;
    const desiredHeight = Math.min(320, options.length * 44 + 12);
    const upwards = below < desiredHeight && above > below;
    const maxHeight = Math.max(44, Math.min(320, upwards ? above : below));
    const menuWidth = Math.min(Math.max(224, rect.width), width - 24);
    Object.assign(picker.style, {
      left: `${Math.max(left + 12, Math.min(rect.left, left + width - menuWidth - 12))}px`,
      top: `${rect.bottom + 4}px`,
      width: `${menuWidth}px`,
      maxHeight: `${maxHeight}px`,
    });
    setActiveIndex(index >= 0 ? index : options.findIndex((option) => !option.disabled));
    trigger.focus({ preventScroll: true });
    picker.showPopover();
    setOpen(true);
    if (upwards) picker.style.top = `${rect.top - picker.getBoundingClientRect().height - 4}px`;
  }

  function choose(index: number) {
    const select = selectRef.current;
    const option = options[index];
    if (!select || select.matches(":disabled") || !option || option.disabled) return;
    if (select.value !== option.value) {
      // Keep native validation, FormData and React change handlers on one control.
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    closePicker();
    triggerRef.current?.focus({ preventScroll: true });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // Native visibility changes before the queued/coalesced toggle notification.
    const open = pickerRef.current?.matches(":popover-open") ?? false;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
    } else if (event.key === "Tab") {
      if (open) choose(activeIndex);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openPicker();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
      if (!enabled.length) return;
      let index = activeIndex;
      if (event.key === "Home") index = enabled[0];
      else if (event.key === "End") index = enabled.at(-1)!;
      else if (open) index = enabled[Math.max(0, Math.min(enabled.length - 1, enabled.indexOf(activeIndex) + (event.key === "ArrowDown" ? 1 : -1)))];
      if (open) setActiveIndex(index);
      else openPicker(event.key === "Home" || event.key === "End" ? index : undefined);
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const now = Date.now();
      const text = now - typeahead.current.time < 600 ? typeahead.current.text + event.key : event.key;
      typeahead.current = { text, time: now };
      const prefix = Array.from(text).every((char) => char === text[0]) ? text[0] : text;
      const start = open ? activeIndex : options.findIndex((option) => option.value === selectedValue);
      const indices = options.map((_, index) => (start + 1 + index) % options.length);
      const match = indices.find((index) => !options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()));
      if (open && match !== undefined) setActiveIndex(match);
      else if (!open) openPicker(match);
    }
  }

  return (
    <span className={classNames}>
      {leadingIcon ? (
        <span aria-hidden="true" className="ios-select__leading">
          {leadingIcon}
        </span>
      ) : null}
      {fallback ? <button
        aria-activedescendant={open && activeIndex >= 0 ? `${pickerId}-option-${activeIndex}` : undefined}
        aria-controls={pickerId}
        aria-describedby={props["aria-describedby"]}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={props["aria-invalid"] ?? (invalid || undefined)}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-required={props.required || undefined}
        className="ios-select__native"
        disabled={disabled}
        id={id}
        onBlur={() => closePicker()}
        onClick={(event) => { event.preventDefault(); if (pickerRef.current?.matches(":popover-open")) closePicker(); else openPicker(); }}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        tabIndex={props.tabIndex}
        title={props.title}
        type="button"
      ><span className="ios-select__value">{selectedLabel}</span></button> : null}
      <ChevronDown aria-hidden="true" className="ios-select__icon" strokeWidth={2.35} />
      <select
        {...props}
        className="ios-select__native"
        defaultValue={value === undefined ? initialValue : undefined}
        disabled={disabled}
        hidden={fallback}
        id={fallback ? undefined : id}
        onChange={handleChange}
        onInvalid={(event) => {
          props.onInvalid?.(event);
          if (fallback) {
            event.preventDefault();
            setInvalid(true);
            const select = event.currentTarget;
            const firstInvalid = select.form?.querySelector("input:invalid, select:invalid, textarea:invalid");
            if (!firstInvalid || firstInvalid === select) openPicker();
          }
        }}
        ref={selectRef}
        value={value}
      >
        {options.map((option) => (
          <option disabled={option.disabled} key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {fallback ? <div
        aria-labelledby={id}
        className="bb-select-picker"
        id={pickerId}
        onClick={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
        popover="auto"
        ref={pickerRef}
        role="listbox"
      >{options.map((option, index) => <div
        aria-disabled={option.disabled || undefined}
        aria-selected={option.value === selectedValue}
        className="bb-select-option"
        data-active={index === activeIndex || undefined}
        id={`${pickerId}-option-${index}`}
        key={option.value}
        onClick={() => choose(index)}
        role="option"
      ><span>{option.label}</span><Check aria-hidden="true" className="bb-select-check" size={18} strokeWidth={2} /></div>)}</div> : null}
    </span>
  );
}
