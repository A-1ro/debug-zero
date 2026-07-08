import { describe, it, expect } from "vitest";
import { determineTurnOrder } from "../../src/server/session/SessionService";
import type { PlayerId, CardId } from "../../src/shared/types/domain";

// D7: 手番決定は「最大値を引いたプレイヤーが先攻 → 着席順（部屋の参加順）で
// 時計回り」（detail-design.md §5.2-1）。引いた値の降順ソートではない。

const PA = "player-a" as PlayerId;
const PB = "player-b" as PlayerId;
const PC = "player-c" as PlayerId;

const rng = () => 0.5; // 返却デッキのシャッフル用（順序検証には影響しない）

describe("determineTurnOrder（D7: 最大値の人が先攻→時計回り）", () => {
  it("最大値を引いたプレイヤーを起点に着席順で時計回りになる", () => {
    // A→3, B→9, C→5 を引く。Bが先攻、以降は着席順で C, A
    const deck: CardId[] = ["3-001", "9-001", "5-001", "1-001", "2-001", "4-001"];

    const { turnOrder } = determineTurnOrder([PA, PB, PC], deck, rng);

    // 降順ソートなら [B, C, A]と同じだが、下のケースと合わせて回転を検証
    expect(turnOrder).toEqual([PB, PC, PA]);
  });

  it("降順ソートではなく着席順の回転になる（2番手以降は引いた値に依存しない）", () => {
    // A→2, B→9, C→5: 降順ソートなら [B, C, A] だが値は同じ。
    // A→5, B→9, C→2 で区別する: 降順ソートなら [B, A, C]、時計回りなら [B, C, A]
    const deck: CardId[] = ["5-001", "9-001", "2-001", "1-001", "3-001", "4-001"];

    const { turnOrder } = determineTurnOrder([PA, PB, PC], deck, rng);

    expect(turnOrder).toEqual([PB, PC, PA]); // Cが先（時計回り）。[PB, PA, PC]ではない
  });

  it("末尾のプレイヤーが最大値なら先頭へ回り込む", () => {
    // A→1, B→2, C→9 → Cが先攻、時計回りで A, B
    const deck: CardId[] = ["1-001", "2-001", "9-001", "3-001", "4-001", "5-001"];

    const { turnOrder } = determineTurnOrder([PA, PB, PC], deck, rng);

    expect(turnOrder).toEqual([PC, PA, PB]);
  });

  it("最大値タイのときは着席順が先のプレイヤーが先攻になる", () => {
    // A→9, B→9, C→5 → タイはAが先攻（文書に規定なし: 着席順先勝ちを採用）
    const deck: CardId[] = ["9-001", "9-002", "5-001", "1-001", "2-001", "3-001"];

    const { turnOrder } = determineTurnOrder([PA, PB, PC], deck, rng);

    expect(turnOrder).toEqual([PA, PB, PC]);
  });

  it("引いたカードはデッキへ戻される（枚数が変わらない）", () => {
    const deck: CardId[] = ["3-001", "9-001", "5-001", "1-001", "2-001", "4-001"];

    const { deck: after } = determineTurnOrder([PA, PB, PC], deck, rng);

    expect(after).toHaveLength(deck.length);
    expect([...after].sort()).toEqual([...deck].sort());
  });

  it("デッキがプレイヤー数より少ないとエラーになる", () => {
    expect(() => determineTurnOrder([PA, PB, PC], ["1-001", "2-001"], rng)).toThrow();
  });
});
