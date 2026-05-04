import * as React from "react";
import "./styles.css";

interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={cx("pixel__label", "pixel-font", className)}
        {...props}
      />
    );
  },
);

Label.displayName = "Label";

export { Label };
