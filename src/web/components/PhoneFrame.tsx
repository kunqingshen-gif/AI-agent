import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  caption?: string;
}

/**
 * 手机外壳：只负责「像一台手机」这件事，内部屏幕由 ScreenView 渲染。
 */
export function PhoneFrame({ children, caption }: Props) {
  return (
    <div className="phone-shell">
      <div className="phone">
        <div className="phone-status">
          <span>9:41</span>
          <span className="phone-notch" />
          <span className="phone-icons">
            <i className="sig" />
            <i className="wifi" />
            <i className="batt" />
          </span>
        </div>
        <div className="phone-screen">{children}</div>
        <div className="phone-home" />
      </div>
      {caption && <p className="phone-caption">{caption}</p>}
    </div>
  );
}
