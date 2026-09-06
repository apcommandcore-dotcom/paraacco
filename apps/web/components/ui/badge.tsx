import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center border px-2 py-0.5 text-xs font-mono tracking-wide", {
  variants: {
    variant: {
      default: "border-line bg-muted text-foreground-2",
      outline: "border-line bg-transparent text-foreground",
      warning: "border-warning-line bg-warning-bg text-warning",
      destructive: "border-destructive-line bg-destructive-bg text-destructive",
      success: "border-ok-line bg-ok-bg text-ok",
      info: "border-info-line bg-info-bg text-info",
      per: "border-per-line bg-per-bg text-per",
      corp: "border-corp-line bg-corp-bg text-corp",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
