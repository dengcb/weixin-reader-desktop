/**
 * Toast 工具类
 * 在屏幕中心显示一个半透明的提示文字
 */

export function showToast(text: string) {
  const id = 'wxrd-toast-container';
  
  // 移除旧的提示
  const oldToast = document.getElementById(id);
  if (oldToast) {
    oldToast.remove();
  }

  // 创建样式（如果不存在）
  if (!document.getElementById('wxrd-toast-style')) {
    const style = document.createElement('style');
    style.id = 'wxrd-toast-style';
    style.textContent = `
      @keyframes wxrdToastFadeOut {
        0% { opacity: 0.6; } /* 起始半透明 */
        100% { opacity: 0; }
      }
      .wxrd-toast {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-family: 'Impact', sans-serif;
        font-weight: 400; /* Regular */
        font-size: 200px;
        color: #848484;
        pointer-events: none;
        z-index: 2147483647; /* Max z-index */
        white-space: nowrap;
        user-select: none;
        animation: wxrdToastFadeOut 0.5s ease-out forwards;
      }
    `;
    document.head.appendChild(style);
  }

  // 创建新提示
  const toast = document.createElement('div');
  toast.id = id;
  toast.className = 'wxrd-toast';
  toast.textContent = text;

  document.body.appendChild(toast);

  // 动画结束后清理
  toast.addEventListener('animationend', () => {
    toast.remove();
  });
}
