const LEGAL_TRANSITIONS = {
  REQUESTED: ['ACCEPTED', 'CANCELED'],
  ACCEPTED: ['STARTED', 'CANCELED'],
  STARTED: ['ENDED', 'PENDING_FARE'],
  ENDED: [],
  CANCELED: [],
  PENDING_FARE: ['ENDED'],
};

function canTransition(currentStatus, nextStatus) {
  return LEGAL_TRANSITIONS[currentStatus]?.includes(nextStatus) || false;
}

function getRequiredRole(currentStatus, nextStatus) {
  if (nextStatus === 'ACCEPTED' || nextStatus === 'STARTED') {
    return 'driver';
  }
  return 'either';
}

module.exports = {
  LEGAL_TRANSITIONS,
  canTransition,
  getRequiredRole,
};
