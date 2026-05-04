import * as React from "react";
import "./styles.css";

type ButtonVariant =
  | "default"
  | "secondary"
  | "warning"
  | "success"
  | "destructive"
  | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "default",
      size = "default",
      type = "button",
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cx(
          "pixel__button",
          "pixel-font",
          `pixel-${variant}__button`,
          `pixel__button--${size}`,
          className,
        )}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export { Button };
