"use client";

import { animate, useReducedMotion } from "motion/react";
import {
  Children,
  createElement,
  isValidElement,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { formatLocaleNumber, type Locale } from "@/lib/i18n";
import { formatFen } from "@/lib/money";

/**
 * 动效原语：三页共用的入场与数字动效。
 * SSR/首帧始终渲染终态（opacity 1、无 transform），hydration 后通过
 * WAAPI 从偏移值播放到终态，避免 hydration mismatch 与子树重挂载。
 * prefers-reduced-motion 下不播放任何动画。
 */

const easeOut = [0.22, 1, 0.36, 1] as const;
const defaultDuration = 0.18;
const enterKeyframes: { opacity: number[]; transform: string[] } = {
  opacity: [0, 1],
  transform: ["translateY(4px)", "translateY(0px)"],
};

const plainTags = [
  "article",
  "div",
  "header",
  "li",
  "p",
  "section",
  "span",
  "ul",
] as const;

type RevealTag = (typeof plainTags)[number];

type RevealProps = {
  as?: RevealTag;
  children?: ReactNode;
  className?: string;
  /** 秒。用于手动编排区块顺序。 */
  delay?: number;
};

/** Subtle entry without delaying the server-rendered content. */
export function Reveal({ as = "div", children, className, delay = 0 }: RevealProps) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;

    if (reduceMotion || !node) {
      return;
    }

    const controls = animate(node, { ...enterKeyframes }, {
      delay,
      duration: defaultDuration,
      ease: [...easeOut],
    });

    return () => controls.stop();
  }, [delay, reduceMotion]);

  // ref 作为 DOM 元素的 ref prop 传入是合法用法；react-hooks/refs 无法识别 createElement 形式。
  // eslint-disable-next-line react-hooks/refs
  return createElement(as, { className, ref }, children);
}

type RevealGroupProps = {
  as?: RevealTag;
  /** 超过该序号的子项不播放动画，直接静止渲染。 */
  cap?: number;
  children?: ReactNode;
  className?: string;
  itemAs?: RevealTag;
  itemClassName?: string;
  /** 相邻子项延迟间隔，秒。 */
  stagger?: number;
};

/**
 * 子项逐个 fade-up 的 stagger 容器。
 * 直接子元素会被包进 itemAs 标签（默认 div），ul/li 场景传 as="ul" itemAs="li"
 * 可保持列表语义与 divide-y 等依赖直接子选择器的样式。
 */
export function RevealGroup({
  as = "div",
  cap = 6,
  children,
  className,
  itemAs = "div",
  itemClassName,
  stagger = 0.025,
}: RevealGroupProps) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = ref.current;

    if (reduceMotion || !container) {
      return;
    }

    const controls = Array.from(container.children)
      .slice(0, cap)
      .map((child, index) =>
        animate(child as HTMLElement, { ...enterKeyframes }, {
          delay: index * stagger,
          duration: defaultDuration,
          ease: [...easeOut],
        }),
      );

    return () => {
      for (const control of controls) {
        control.stop();
      }
    };
  }, [cap, reduceMotion, stagger]);

  const items = Children.toArray(children).map((child, index) => {
    const key = isValidElement(child) && child.key != null ? child.key : index;

    return createElement(itemAs, { className: itemClassName, key }, child);
  });

  // 同上：ref 作为 DOM 元素的 ref prop 传入。
  // eslint-disable-next-line react-hooks/refs
  return createElement(as, { className, ref }, items);
}

type CountUpProps = {
  className?: string;
  /** 秒。 */
  duration?: number;
  locale: Locale;
  /** 目标数值；fen 变体传分，integer 变体传整数。 */
  value: number;
  variant: "fen" | "integer";
};

/**
 * 首次 mount 时从 0 count-up 到目标值；之后 value 变化直接跳变不重复动画。
 * SSR 渲染终态文本，hydration 后再播放动画。
 */
export function CountUp({ className, duration = 0.4, locale, value, variant }: CountUpProps) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const playedRef = useRef(false);
  const format = (current: number) => {
    const rounded = Math.round(current);

    return variant === "fen"
      ? `${rounded < 0 ? "-" : ""}${formatFen(Math.abs(rounded))}`
      : formatLocaleNumber(rounded, locale);
  };

  useEffect(() => {
    const node = ref.current;

    if (!node) {
      return;
    }

    if (reduceMotion || playedRef.current) {
      node.textContent = format(value);
      playedRef.current = true;
      return;
    }

    playedRef.current = true;
    const controls = animate(0, value, {
      duration,
      ease: [...easeOut],
      onUpdate: (latest) => {
        node.textContent = format(latest);
      },
    });

    return () => controls.stop();
    // format 依赖 locale/variant，二者在组件生命周期内不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduceMotion, duration]);

  return (
    <span className={className} ref={ref}>
      {format(value)}
    </span>
  );
}
