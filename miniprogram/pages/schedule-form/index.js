const { call, getUser, waitForUser } = require("../../utils/call");
const { ROLE, STATUS_META } = require("../../utils/status");
const { dateTimeFields, buildCreatePayload, createRequestId } = require("../../utils/schedule-form");

const blankForm = () => ({
  sport: "", rival: "", location: "", demands: [], isTbd: false,
  startDate: "", startTime: "", endDate: "", endTime: "",
});
const demandOptions = (selected = []) => ["饮用水", "记分", "摄影"].map((value) => ({
  value, checked: selected.includes(value),
}));

Page({
  data: {
    form: blankForm(),
    demandOptions: demandOptions(),
    minDate: "",
    ready: false,
    authorized: false,
    saving: false,
    retryPending: false,
    saved: false,
    viewOnly: false,
    errorText: "",
    statusLabel: "",
    statusColor: "",
  },
});
