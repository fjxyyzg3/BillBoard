"use client";

import { ChevronDown } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";

type IosDateTimeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> & {
  className?: string;
  leadingIcon?: ReactNode;
};

export function IosDateTimeInput({ className, leadingIcon, ...props }: IosDateTimeInputProps) {
  const classNames = [
    "ios-datetime",
    leadingIcon ? "ios-datetime--with-leading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classNames}>
      {leadingIcon ? (
        <span aria-hidden="true" className="ios-datetime__leading">
          {leadingIcon}
        </span>
      ) : null}
      <input {...props} className="ios-datetime__native" type="datetime-local" />
      <span aria-hidden="true" className="ios-datetime__icon">
        <ChevronDown strokeWidth={2.35} />
      </span>
    </span>
  );
}
