import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  caption?: string;
  /**
   * 浮在屏幕上的东西（例如「您要办的是哪一件」）。
   *
   * 挂在这里而不是挂在手机外面：屏幕本身是 overflow:hidden 的圆角容器，
   * 遮罩放进来就自然被裁成手机的圆角，也不会算出半截高度。
   */
  overlay?: ReactNode;
}

/**
 * 手机外壳：只负责「像一台手机」这件事，内部屏幕由 ScreenView 渲染。
 */
export function PhoneFrame({ children, caption, overlay }: Props) {
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
        <div className="phone-screen">
          {children}
          {overlay}
        </div>
        <div className="phone-home" />
      </div>
      {caption && <p className="phone-caption">{caption}</p>}
    </div>
  );
}
