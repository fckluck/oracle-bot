// Oracle v38.5 lightweight regression fixtures.
// Static cases used for manual replay / sanity checks.

module.exports = {
  winnersShouldNotBePlainNoGo: [
    { ticker: 'GRAIL', expected: ['ORACLE_BUY', 'MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'DATBIHGAH', expected: ['ORACLE_BUY', 'MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'FRIDAY_RUNNER', expected: ['ORACLE_BUY', 'MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'NEAN', expected: ['ORACLE_BUY', 'MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'GRUG', expected: ['MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'IPO', expected: ['MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'BAMBIS', expected: ['MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'ALPHA', expected: ['ORACLE_BUY', 'MISSED_WINNER_MATCH', 'DIRTY_RUNNER_WATCH'] },
    { ticker: 'BETA', expected: ['ORACLE_BUY'] },
    { ticker: 'CWIF', expected: ['ORACLE_BUY'] },
  ],
  garbageShouldStayBlocked: [
    { ticker: 'AUREL', expectedNot: ['ORACLE_BUY'] },
    { ticker: 'SCHLONG', expectedNot: ['ORACLE_BUY'] },
    { ticker: 'SWEETHEART', expectedNot: ['ORACLE_BUY'] },
    { ticker: 'FYATT', expectedNot: ['ORACLE_BUY'] },
    { ticker: 'BOUNCE', expectedNot: ['ORACLE_BUY'] },
  ],
};
