export class PositionHistory<T> {
  private entries: T[] = [];
  private index = -1;
  private moving = false;

  reset(value: T): void {
    this.entries = [value];
    this.index = 0;
    this.moving = false;
  }

  replace(value: T): void {
    if (this.moving || this.index < 0) return;
    this.entries[this.index] = value;
  }

  async record(
    current: T,
    move: () => void | Promise<void>,
    destination: () => T,
  ): Promise<void> {
    if (this.moving) return;
    const prefix = this.entries.slice(0, this.index + 1);
    if (this.index >= 0) prefix[this.index] = current;
    this.moving = true;
    try {
      await move();
      prefix.push(destination());
      this.entries = prefix;
      this.index = prefix.length - 1;
    } finally {
      this.moving = false;
    }
  }

  async back(move: (value: T) => void | Promise<void>): Promise<boolean> {
    if (this.moving || this.index <= 0) return false;
    const targetIndex = this.index - 1;
    this.moving = true;
    try {
      await move(this.entries[targetIndex]);
      this.index = targetIndex;
      return true;
    } finally {
      this.moving = false;
    }
  }

  async forward(move: (value: T) => void | Promise<void>): Promise<boolean> {
    if (this.moving || this.index < 0 || this.index >= this.entries.length - 1) return false;
    const targetIndex = this.index + 1;
    this.moving = true;
    try {
      await move(this.entries[targetIndex]);
      this.index = targetIndex;
      return true;
    } finally {
      this.moving = false;
    }
  }
}
