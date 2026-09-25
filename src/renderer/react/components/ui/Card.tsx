import type { ComponentPropsWithoutRef, ElementType } from "react";
import "./Card.css";

export type CardProps<T extends ElementType = "div"> = {
  as?: T;
  className?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className">;

export function Card<T extends ElementType = "div">({ as, className, ...props }: CardProps<T>) {
  const Component = as ?? "div";
  return (
    <Component
      data-slot="card"
      className={["cy-shadcn-card", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}
