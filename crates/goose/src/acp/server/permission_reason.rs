//! Why a client denied a tool call (ModelForge requirement 15.5). A client that runs its own
//! approval flow, such as the desktop's Feishu connector, answers `session/request_permission`
//! with a reject option and says why in the response's `_meta`:
//!
//! ```json
//! { "outcome": { "outcome": "selected", "optionId": "reject_once" },
//!   "_meta": { "modelforge/permission": { "reason": "timeout" } } }
//! ```
//!
//! `"rejected"` means the approver said no, `"timeout"` that nobody approved in time. The denied
//! tool's result then reads "已拒绝" or "已超时" instead of the generic declined text. A reason
//! on an approval, an unknown reason or a malformed `_meta` changes nothing.

use agent_client_protocol::schema::v1::Meta;

use crate::agents::tool_execution::ToolDenialReason;
use crate::permission::Permission;

/// `_meta` key of the denial details in a permission response.
pub(super) const PERMISSION_META_KEY: &str = "modelforge/permission";

/// The reason in a permission response's `_meta`, when `permission` denies the call.
pub(super) fn denial_reason_from_meta(
    meta: Option<&Meta>,
    permission: &Permission,
) -> Option<ToolDenialReason> {
    if !matches!(
        permission,
        Permission::DenyOnce | Permission::AlwaysDeny | Permission::Cancel
    ) {
        return None;
    }
    let reason = meta?.get(PERMISSION_META_KEY)?.get("reason")?.as_str()?;
    ToolDenialReason::from_wire(reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::RequestPermissionResponse;
    use serde_json::json;
    use test_case::test_case;

    fn meta(value: serde_json::Value) -> Meta {
        value.as_object().cloned().expect("meta must be an object")
    }

    #[test_case(json!({ "modelforge/permission": { "reason": "rejected" } }), Permission::DenyOnce, Some(ToolDenialReason::Rejected); "rejected")]
    #[test_case(json!({ "modelforge/permission": { "reason": "timeout" } }), Permission::DenyOnce, Some(ToolDenialReason::TimedOut); "timed out")]
    #[test_case(json!({ "modelforge/permission": { "reason": "timeout" } }), Permission::Cancel, Some(ToolDenialReason::TimedOut); "cancelled with a reason")]
    #[test_case(json!({ "modelforge/permission": { "reason": "rejected" } }), Permission::AlwaysDeny, Some(ToolDenialReason::Rejected); "always deny")]
    #[test_case(json!({ "modelforge/permission": { "reason": "rejected" } }), Permission::AllowOnce, None; "an approval ignores the reason")]
    #[test_case(json!({ "modelforge/permission": { "reason": "rejected" } }), Permission::AlwaysAllow, None; "an always allow ignores the reason")]
    #[test_case(json!({ "modelforge/permission": { "reason": "expired" } }), Permission::DenyOnce, None; "unknown reason")]
    #[test_case(json!({ "modelforge/permission": { "reason": 1 } }), Permission::DenyOnce, None; "reason is not a string")]
    #[test_case(json!({ "modelforge/permission": "timeout" }), Permission::DenyOnce, None; "details are not an object")]
    #[test_case(json!({ "reason": "timeout" }), Permission::DenyOnce, None; "reason outside the key")]
    fn reads_the_denial_reason(
        value: serde_json::Value,
        permission: Permission,
        expected: Option<ToolDenialReason>,
    ) {
        assert_eq!(
            denial_reason_from_meta(Some(&meta(value)), &permission),
            expected
        );
    }

    #[test]
    fn no_meta_means_no_reason() {
        assert_eq!(denial_reason_from_meta(None, &Permission::DenyOnce), None);
    }

    #[test]
    fn a_wire_response_carries_the_reason_to_the_caller() {
        let response: RequestPermissionResponse = serde_json::from_value(json!({
            "outcome": { "outcome": "selected", "optionId": "reject_once" },
            "_meta": { "modelforge/permission": { "reason": "timeout" } },
        }))
        .unwrap();

        let permission = super::super::outcome_to_confirmation(&response.outcome).permission;

        assert_eq!(permission, Permission::DenyOnce);
        assert_eq!(
            denial_reason_from_meta(response.meta.as_ref(), &permission),
            Some(ToolDenialReason::TimedOut)
        );
    }

    #[test]
    fn a_cancelled_wire_response_keeps_its_reason() {
        let response: RequestPermissionResponse = serde_json::from_value(json!({
            "outcome": { "outcome": "cancelled" },
            "_meta": { "modelforge/permission": { "reason": "rejected" } },
        }))
        .unwrap();

        let permission = super::super::outcome_to_confirmation(&response.outcome).permission;

        assert_eq!(permission, Permission::Cancel);
        assert_eq!(
            denial_reason_from_meta(response.meta.as_ref(), &permission),
            Some(ToolDenialReason::Rejected)
        );
    }
}
