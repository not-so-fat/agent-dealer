// NOT-369: sleep-timer notice from captured `pmset -g custom` fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SLEEP_TIMER_FIX_COMMAND,
  checkSleepTimer,
  parseAcSleepMinutes,
  resetSleepTimerNoticeForTests,
  getSleepTimerNotice,
} from "./sleep-timer.js";

const FIXTURE_AC_SLEEP = (minutes: number) => `Battery Power:
 Sleep On Power Button 1
 sleep                1
 displaysleep         3
AC Power:
 Sleep On Power Button 1
 sleep                ${minutes}
 displaysleep         10
 tcpkeepalive         1
`;

test("parseAcSleepMinutes reads the AC Power sleep value", () => {
  assert.equal(parseAcSleepMinutes(FIXTURE_AC_SLEEP(1)), 1);
  assert.equal(parseAcSleepMinutes(FIXTURE_AC_SLEEP(0)), 0);
  assert.equal(parseAcSleepMinutes(FIXTURE_AC_SLEEP(30)), 30);
  assert.equal(parseAcSleepMinutes(""), null);
  assert.equal(parseAcSleepMinutes("Battery Power:\n sleep 1\n"), null);
});

test("notice for AC sleep 1–29; none for 0, 30+, missing, or non-darwin", () => {
  for (const minutes of [1, 15, 29]) {
    const notice = checkSleepTimer({
      platform: "darwin",
      runPmsetCustom: () => FIXTURE_AC_SLEEP(minutes),
    });
    assert.ok(notice, `expected notice for sleep ${minutes}`);
    assert.equal(notice.acSleepMinutes, minutes);
    assert.equal(notice.fixCommand, SLEEP_TIMER_FIX_COMMAND);
    assert.match(notice.message, /sudo pmset -c sleep 0/);
    assert.match(notice.message, /only while work is active/);
  }

  for (const minutes of [0, 30, 60]) {
    assert.equal(
      checkSleepTimer({
        platform: "darwin",
        runPmsetCustom: () => FIXTURE_AC_SLEEP(minutes),
      }),
      null,
      `no notice for sleep ${minutes}`
    );
  }

  assert.equal(
    checkSleepTimer({ platform: "darwin", runPmsetCustom: () => "" }),
    null,
    "missing output"
  );
  assert.equal(
    checkSleepTimer({
      platform: "darwin",
      runPmsetCustom: () => "Battery Power:\n sleep 1\n",
    }),
    null,
    "AC section missing"
  );
  assert.equal(
    checkSleepTimer({
      platform: "linux",
      runPmsetCustom: () => FIXTURE_AC_SLEEP(1),
    }),
    null,
    "non-darwin"
  );
  assert.equal(
    checkSleepTimer({
      platform: "win32",
      runPmsetCustom: () => FIXTURE_AC_SLEEP(1),
    }),
    null
  );
});

test("check never invokes sudo or writes settings (runner only receives pmset -g custom)", () => {
  const calls: string[] = [];
  checkSleepTimer({
    platform: "darwin",
    runPmsetCustom: () => {
      calls.push("pmset -g custom");
      return FIXTURE_AC_SLEEP(5);
    },
  });
  assert.deepEqual(calls, ["pmset -g custom"]);
  assert.ok(!calls.some((c) => c.includes("sudo") || c.includes("pmset -c")));
});

test("getSleepTimerNotice with explicit opts is not process-cached across different runners", () => {
  resetSleepTimerNoticeForTests();
  const a = getSleepTimerNotice({
    platform: "darwin",
    runPmsetCustom: () => FIXTURE_AC_SLEEP(3),
  });
  const b = getSleepTimerNotice({
    platform: "darwin",
    runPmsetCustom: () => FIXTURE_AC_SLEEP(0),
  });
  assert.ok(a);
  assert.equal(b, null);
  resetSleepTimerNoticeForTests();
});
