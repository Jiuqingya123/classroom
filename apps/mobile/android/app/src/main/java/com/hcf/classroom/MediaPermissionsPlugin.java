package com.hcf.classroom;

import android.Manifest;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * WebView 的 getUserMedia 只会弹浏览器层的授权，Android 运行时权限需要原生侧先申请。
 * 每次进课堂/设备自检前调用 request()，避免首帧黑屏后才发现相机被系统拒绝。
 */
@CapacitorPlugin(
    name = "MediaPermissions",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class MediaPermissionsPlugin extends Plugin {

    @PluginMethod
    public void request(PluginCall call) {
        if (isGranted("camera") && isGranted("microphone")) {
            resolve(call);
            return;
        }
        requestAllPermissions(call, "onPermissionsResult");
    }

    @PermissionCallback
    private void onPermissionsResult(PluginCall call) {
        resolve(call);
    }

    private boolean isGranted(String alias) {
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    private void resolve(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("camera", getPermissionState("camera").toString());
        ret.put("microphone", getPermissionState("microphone").toString());
        call.resolve(ret);
    }
}
