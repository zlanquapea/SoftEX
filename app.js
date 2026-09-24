const dialog = document.querySelector('#createDialog');
const toast = document.querySelector('.toast');

document.querySelector('#createButton').addEventListener('click', () => dialog.showModal());
document.querySelector('.close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

document.querySelectorAll('.task input').forEach((checkbox) => {
  checkbox.addEventListener('change', () => {
    toast.textContent = checkbox.checked ? 'Task marked complete' : 'Task moved back to today';
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 1800);
  });
});

document.querySelectorAll('[data-create]').forEach((button) => {
  button.addEventListener('click', () => {
    dialog.close();
    toast.textContent = `${button.dataset.create[0].toUpperCase()}${button.dataset.create.slice(1)} creation is ready for the next sprint`;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2200);
  });
});

document.querySelector('.mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('#searchButton').focus();
  }
});
