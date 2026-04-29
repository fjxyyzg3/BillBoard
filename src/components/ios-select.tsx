"use client";

import { ChevronDown } from "lucide-react";
import { useState, type ChangeEvent, type SelectHTMLAttributes } from "react";

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
  options: IosSelectOption[];
  value?: string;
  variant?: "field" | "pill";
};

function getSelectedLabel(options: IosSelectOption[], value: string) {
  return options.find((option) => option.value === value)?.label ?? options[0]?.label ?? "";
}

export function IosSelect({
  className,
  defaultValue,
  onChange,
  options,
  value,
  variant = "field",
  ...props
}: IosSelectProps) {
  const initialValue = value ?? defaultValue ?? options[0]?.value ?? "";
  const [currentValue, setCurrentValue] = useState(initialValue);
  const selectedValue = value ?? currentValue;
  const selectedLabel = getSelectedLabel(options, selectedValue);
  const classNames = [
    "ios-select",
    variant === "pill" ? "ios-select--pill" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    setCurrentValue(event.target.value);
    onChange?.(event);
  }

  return (
    <span className={classNames}>
      <span aria-hidden="true" className="ios-select__value">
        {selectedLabel}
      </span>
      <ChevronDown aria-hidden="true" className="ios-select__icon" strokeWidth={2.35} />
      <select
        {...props}
        className="ios-select__native"
        defaultValue={value === undefined ? initialValue : undefined}
        onChange={handleChange}
        value={value}
      >
        {options.map((option) => (
          <option disabled={option.disabled} key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
