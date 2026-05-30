'use strict';

function formatEt(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(new Date(ts));
}

function formatUtc(ts = Date.now()) {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function actionTimeLine(label = 'Action Time', ts = Date.now()) {
  return `🕒 <b>${label}:</b> ${formatEt(ts)} | ${formatUtc(ts)}`;
}

module.exports = { formatEt, formatUtc, actionTimeLine };
