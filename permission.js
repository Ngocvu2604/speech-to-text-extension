const btnGrant = document.getElementById('btnGrant');
const statusBox = document.getElementById('statusBox');

async function requestPermission() {
  btnGrant.disabled = true;
  btnGrant.querySelector('span').textContent = 'Đang đợi bạn xác nhận...';
  statusBox.className = 'status-box';
  statusBox.style.display = 'none';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    stream.getTracks().forEach(track => track.stop());

    statusBox.className = 'status-box status-success';
    statusBox.innerHTML = '<strong>Thành công!</strong> Đã cấp quyền micro. Đang quay lại tiện ích...';
    btnGrant.querySelector('span').textContent = 'Đã cấp quyền thành công!';

    try {
      chrome.runtime.sendMessage({ action: 'MICROPHONE_PERMISSION_GRANTED' });
    } catch (e) {

    }

    setTimeout(() => {
      window.close();
    }, 800);
  } catch (err) {
    btnGrant.disabled = false;
    btnGrant.querySelector('span').textContent = 'Thử lại cấp quyền';
    statusBox.className = 'status-box status-error';

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      statusBox.innerHTML = `
        <strong>Quyền micro đang bị chặn:</strong><br>
        1. Nhấp vào biểu tượng <strong>Ổ khóa hoặc Cài đặt trang web</strong> ở bên trái thanh địa chỉ URL (trên cùng trình duyệt).<br>
        2. Chuyển quyền <strong>Microphone</strong> sang <strong>Cho phép (Allow)</strong>.<br>
        3. Bấm lại nút "Thử lại cấp quyền" ở trên.
      `;
    } else {
      statusBox.innerHTML = `<strong>Lỗi:</strong> ${err.message || err.name
}`;
    }
  }
}

btnGrant.addEventListener('click', requestPermission);

window.addEventListener('DOMContentLoaded', () => {

  requestPermission();
});
