interface SpinnerProps {
  size?: number;
}

export default function Spinner(props: SpinnerProps) {
  const size = () => props.size || 16;

  return (
    <span
      class="spinner"
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        display: "inline-block",
        "vertical-align": "middle",
      }}
    />
  );
}
