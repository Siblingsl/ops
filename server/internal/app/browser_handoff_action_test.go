package app

// B-01.5：人工接管动作必须在服务端动作登记表内，否则浏览器命令接口会以
// browser_action_unsupported 拒绝；完成事件走扩展上行，不产生第二条命令。
import "testing"

func TestBrowserHandoffActionRegistered(t *testing.T) {
	if !browserCommandActions["handoff_request"] {
		t.Fatal("handoff_request 未登记到 browserCommandActions")
	}
	if browserCommandActions["execute_arbitrary_js"] {
		t.Fatal("任意 JS 动作不得登记")
	}
}
