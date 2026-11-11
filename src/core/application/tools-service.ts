import type { TaskId } from '@shared/types';
import { MATERIAL_LIBRARY } from '@shared/household';
import type { ClockPort } from '../ports';
import { preflightCheck, type PreflightResult } from '../domain/preflight';
import { lifeItemsAt, scanLifecycle, type LifeScan } from '../domain/lifecycle';
import { assessScam, type ScamAssessment } from '../domain/scam';

/**
 * 管家能力：办前体检、守护日历、可疑话术。
 *
 * 这三件事与「带用户办一件事」并列，但不是同一种工作：
 * 它们不产生引导动作，只回答「我这情况怎么样」。
 * 单独成块后，AssistService 只负责把话路由到这儿，不再掺着业务判断。
 */
export class ToolsService {
  constructor(private readonly clock: ClockPort) {}

  /**
   * 办前体检。
   *
   * 不传事项时用会话里正在办的那一件；没有会话就按低保复核演示。
   * 这里刻意不做「智能猜事项」——猜错事项的体检比不做更糟，
   * 它会让人拿着一份不相干的清单去补材料。
   */
  preflight(taskId?: TaskId): PreflightResult | null {
    return preflightCheck({
      taskId: taskId ?? 'allowance.renew',
      materials: MATERIAL_LIBRARY,
      now: new Date(this.clock.now()),
    });
  }

  /** 守护日历：把分散在各部门的时间点收成一张表 */
  lifecycle(): LifeScan {
    const now = new Date(this.clock.now());
    /* 到期日按「今天」现算，否则演示数据会随日历腐烂，跨月后「还有 6 天」变成「已经过了 5 天」 */
    return scanLifecycle(lifeItemsAt(now), now);
  }

  /** 可疑话术判别 */
  scam(text: string): ScamAssessment {
    return assessScam(text);
  }
}
