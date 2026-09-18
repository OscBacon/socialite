import { ImageResponse } from "next/og";
import { SocialiteImageMark } from "./_components/socialite-image-mark";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#050505",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <SocialiteImageMark size={112} />
    </div>,
    size,
  );
}
