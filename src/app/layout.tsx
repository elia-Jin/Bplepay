import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "비플페이 지도",
  description: "구획 이름을 입력하면 식당을 지도에 표시하고, 비플페이 가능 여부를 함께 기록하는 서비스",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
