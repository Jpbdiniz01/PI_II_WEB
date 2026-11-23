'use strict';

const CHAVE_MEDICO = 'ps_ultimo_medico';

const MANCHESTER = {
  vermelho: { nome: 'Vermelho', descricao: 'Emergência', ordem: 1, tempo: 0, meta: 'Atendimento imediato' },
  laranja: { nome: 'Laranja', descricao: 'Muito urgente', ordem: 2, tempo: 10, meta: 'Até 10 minutos' },
  amarelo: { nome: 'Amarelo', descricao: 'Urgente', ordem: 3, tempo: 60, meta: 'Até 60 minutos' },
  verde: { nome: 'Verde', descricao: 'Pouco urgente', ordem: 4, tempo: 120, meta: 'Até 120 minutos' },
  azul: { nome: 'Azul', descricao: 'Não urgente', ordem: 5, tempo: 240, meta: 'Até 240 minutos' }
};

const STATUS = {
  triagem: { rotulo: 'Aguardando triagem', classe: 'st-triagem' },
  medico: { rotulo: 'Aguardando médico', classe: 'st-medico' },
  confirmado: { rotulo: 'Atendimento confirmado', classe: 'st-confirmado' },
  cancelado: { rotulo: 'Cancelado', classe: 'st-cancelado' }
};

let QUEIXAS = [];
let VIAS = [];
const catalogo = { queixas: {}, vias: {} };

const estado = { visao: 'recepcao', editandoId: null, triagemId: null, medicoId: null };

let db = { pacientes: [], atendimentos: [] };
let gravando = false;

async function api(caminho, { metodo = 'GET', corpo, retorno = false } = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    method: metodo,
    headers: {
      apikey: SUPABASE_CHAVE,
      Authorization: `Bearer ${SUPABASE_CHAVE}`,
      'Content-Type': 'application/json',
      ...(retorno ? { Prefer: 'return=representation' } : {})
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo)
  });
  const texto = await resp.text();
  const dados = texto ? JSON.parse(texto) : null;
  if (!resp.ok) {
    const erro = new Error((dados && dados.message) || `Erro ${resp.status}`);
    erro.codigo = dados && dados.code;
    throw erro;
  }
  return dados;
}

function msgErro(e) {
  if (e.codigo === '23505') return 'Registro duplicado: CPF já cadastrado ou paciente com atendimento em andamento';
  if (e instanceof TypeError) return 'Sem conexão com o banco de dados';
  return e.message || 'Erro inesperado';
}

async function executar(fn) {
  if (gravando) return;
  gravando = true;
  try {
    await fn();
  } catch (e) {
    aviso(msgErro(e), 'erro');
  } finally {
    gravando = false;
  }
}

async function carregarCatalogo() {
  const [q, v] = await Promise.all([
    api('queixa?select=id,descricao&order=id'),
    api('via_administracao?select=id,descricao&order=id')
  ]);
  QUEIXAS = q.map(x => x.descricao);
  VIAS = v.map(x => x.descricao);
  q.forEach(x => { catalogo.queixas[x.descricao] = x.id; });
  v.forEach(x => { catalogo.vias[x.descricao] = x.id; });
}

function mapPaciente(p) {
  return {
    id: p.id, nome: p.nome, nascimento: p.data_nascimento, cpf: p.cpf, rg: p.rg,
    pai: p.nome_pai || '', mae: p.nome_mae, telefone: p.telefone || '', endereco: p.endereco
  };
}

function mapAtendimento(a) {
  const t = Array.isArray(a.triagem) ? a.triagem[0] : a.triagem;
  return {
    id: a.id,
    numero: a.numero,
    pacienteId: a.paciente_id,
    status: a.status_atendimento.codigo,
    criadoEm: Date.parse(a.data_chegada),
    triagem: t ? {
      id: t.id,
      sis: t.pressao_sistolica,
      dia: t.pressao_diastolica,
      temp: Number(t.temperatura),
      fc: t.batimentos,
      queixas: (t.triagem_queixa || []).map(x => x.queixa.descricao),
      outras: t.outras_queixas || '',
      classificacao: t.classificacao_manchester.cor,
      em: Date.parse(t.data_triagem)
    } : null,
    medicacoes: (a.medicacao || []).slice().sort((x, y) => x.id - y.id).map(m => ({
      id: m.id, nome: m.medicamento, dose: m.dose, via: m.via_administracao.descricao,
      obs: m.observacao || '', em: Date.parse(m.registrado_em)
    })),
    conduta: a.conduta || '',
    medico: a.medico ? a.medico.nome : '',
    confirmadoEm: a.data_confirmacao ? Date.parse(a.data_confirmacao) : null,
    canceladoEm: a.data_cancelamento ? Date.parse(a.data_cancelamento) : null,
    motivoCancelamento: a.motivo_cancelamento || ''
  };
}

async function recarregar() {
  const [pac, at] = await Promise.all([
    api('paciente?select=*&order=id'),
    api('atendimento?select=*,status_atendimento(codigo),medico(nome),triagem(*,classificacao_manchester(cor),triagem_queixa(queixa(descricao))),medicacao(*,via_administracao(descricao))&order=id')
  ]);
  db = { pacientes: pac.map(mapPaciente), atendimentos: at.map(mapAtendimento) };
}

function ultimoMedico() {
  try { return localStorage.getItem(CHAVE_MEDICO) || ''; } catch (e) { return ''; }
}

function lembrarMedico(nome) {
  try { localStorage.setItem(CHAVE_MEDICO, nome); } catch (e) {}
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digitos = v => String(v || '').replace(/\D/g, '');
const pad = (n, t) => String(n).padStart(t, '0');

function fmtCPF(v) {
  const d = digitos(v).slice(0, 11);
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function fmtTel(v) {
  const d = digitos(v).slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function cpfValido(v) {
  const d = digitos(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(d[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}

function gerarCPF(base) {
  const d = String(base).padStart(9, '0').split('').map(Number);
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += d[i] * (t + 1 - i);
    d.push(((s * 10) % 11) % 10);
  }
  return d.join('');
}

function hojeISO() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const fmtData = iso => {
  if (!iso) return '—';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};

const fmtDataHora = ts => ts
  ? new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';

const fmtHora = ts => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function idade(iso) {
  if (!iso) return '';
  const n = new Date(iso + 'T00:00:00');
  const h = new Date();
  let a = h.getFullYear() - n.getFullYear();
  const m = h.getMonth() - n.getMonth();
  if (m < 0 || (m === 0 && h.getDate() < n.getDate())) a--;
  return a;
}

function minutosDesde(ts) {
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
}

function fmtEspera(ts) {
  const min = minutosDesde(ts);
  const h = Math.floor(min / 60);
  return h ? `${h}h ${pad(min % 60, 2)}min` : `${min} min`;
}

const pacientePorId = id => db.pacientes.find(p => p.id === id);
const atendPorId = id => db.atendimentos.find(a => a.id === id);
const comPaciente = a => ({ ...a, paciente: pacientePorId(a.pacienteId) || {} });
const editavel = a => a.status === 'triagem' || a.status === 'medico';

const badge = c => `<span class="badge cor-${c}">${MANCHESTER[c].nome} · ${MANCHESTER[c].descricao}</span>`;
const statusTag = s => `<span class="status ${STATUS[s].classe}">${STATUS[s].rotulo}</span>`;

function aviso(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + tipo;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3200);
}

function limparErros(form) {
  $$('.invalid', form).forEach(e => e.classList.remove('invalid'));
  $$('.err', form).forEach(e => e.remove());
}

function marcarErro(el, msg) {
  const alvo = el.matches('input,select,textarea') ? (el.closest('label') || el.parentElement) : el;
  alvo.classList.add('invalid');
  const s = document.createElement('small');
  s.className = 'err';
  s.textContent = msg;
  alvo.appendChild(s);
}

function confirmar({ titulo, texto, motivo = false, ok = 'Confirmar', perigo = false }) {
  return new Promise(resolve => {
    const dlg = $('#dlg-confirm');
    $('#cf-titulo').textContent = titulo;
    $('#cf-texto').textContent = texto;
    const campo = $('#cf-motivo');
    campo.value = '';
    $('#cf-motivo-wrap').classList.toggle('hidden', !motivo);
    const bt = $('#cf-ok');
    bt.textContent = ok;
    bt.className = 'btn ' + (perigo ? 'danger' : 'primary');
    const fim = v => { dlg.close(); resolve(v); };
    bt.onclick = () => fim({ motivo: campo.value.trim() });
    $('#cf-cancel').onclick = () => fim(null);
    dlg.oncancel = e => { e.preventDefault(); fim(null); };
    dlg.showModal();
  });
}

function irPara(v) {
  estado.visao = v;
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  render();
  window.scrollTo(0, 0);
}

function atualizarContadores() {
  const t = db.atendimentos.filter(a => a.status === 'triagem').length;
  const m = db.atendimentos.filter(a => a.status === 'medico').length;
  $('#cnt-triagem').textContent = t;
  $('#cnt-triagem').classList.toggle('hidden', !t);
  $('#cnt-medico').textContent = m;
  $('#cnt-medico').classList.toggle('hidden', !m);
}

function render() {
  atualizarContadores();
  if (estado.visao === 'recepcao') renderRecepcao();
  else if (estado.visao === 'triagem') renderTriagem();
  else renderMedico();
}

const formRec = $('#form-recepcao');

function lerFormRec() {
  const o = {};
  for (const [k, v] of new FormData(formRec)) o[k] = String(v).trim();
  return o;
}

function limparRec() {
  formRec.reset();
  limparErros(formRec);
  estado.editandoId = null;
  $('#rec-titulo').textContent = 'Novo atendimento';
  $('#rec-salvar').textContent = 'Registrar atendimento';
  $('#rec-limpar').textContent = 'Limpar';
  $('#rec-aviso').classList.add('hidden');
}

function preencherPorCPF() {
  const pac = db.pacientes.find(p => p.cpf === digitos(formRec.elements.cpf.value));
  const av = $('#rec-aviso');
  if (!pac) { av.classList.add('hidden'); return; }
  for (const k of ['nome', 'nascimento', 'rg', 'pai', 'mae', 'telefone', 'endereco']) {
    formRec.elements[k].value = k === 'telefone' ? fmtTel(pac[k]) : (pac[k] || '');
  }
  av.textContent = 'Paciente já cadastrado: dados preenchidos automaticamente. Confira e atualize se necessário.';
  av.classList.remove('hidden');
}

function salvarRecepcao(e) {
  e.preventDefault();
  limparErros(formRec);
  $('#rec-sucesso').classList.add('hidden');
  const d = lerFormRec();
  let primeiro = null;
  const falha = (nome, msg) => {
    const c = formRec.elements[nome];
    marcarErro(c, msg);
    if (!primeiro) primeiro = c;
  };

  if (d.nome.length < 5 || !d.nome.includes(' ')) falha('nome', 'Informe o nome completo');
  if (!d.nascimento) falha('nascimento', 'Informe a data de nascimento');
  else if (d.nascimento > hojeISO()) falha('nascimento', 'Data no futuro');
  if (!cpfValido(d.cpf)) falha('cpf', 'CPF inválido');
  if (!d.rg) falha('rg', 'Informe o RG');
  if (!d.mae) falha('mae', 'Informe o nome da mãe');
  if (!d.endereco) falha('endereco', 'Informe o endereço');
  if (d.telefone && digitos(d.telefone).length < 10) falha('telefone', 'Telefone incompleto');
  if (primeiro) { primeiro.focus(); return; }

  const cpf = digitos(d.cpf);
  const dados = {
    nome: d.nome,
    data_nascimento: d.nascimento,
    cpf,
    rg: d.rg,
    nome_pai: d.pai || null,
    nome_mae: d.mae,
    telefone: digitos(d.telefone) || null,
    endereco: d.endereco
  };

  executar(async () => {
    if (estado.editandoId) {
      const id = estado.editandoId;
      const atual = await api(`atendimento?id=eq.${id}&select=numero,paciente_id,status_id`);
      if (!atual.length || ![1, 2].includes(atual[0].status_id)) {
        aviso('Este atendimento não pode mais ser alterado', 'erro');
        limparRec();
        await recarregar();
        render();
        return;
      }
      const pid = atual[0].paciente_id;
      const outro = await api(`paciente?cpf=eq.${cpf}&id=neq.${pid}&select=id`);
      if (outro.length) {
        marcarErro(formRec.elements.cpf, 'CPF pertence a outro paciente');
        formRec.elements.cpf.focus();
        return;
      }
      await api(`paciente?id=eq.${pid}`, { metodo: 'PATCH', corpo: dados });
      aviso(`Atendimento ${atual[0].numero} atualizado`);
      limparRec();
      await recarregar();
      render();
      return;
    }

    const existente = await api(`paciente?cpf=eq.${cpf}&select=id`);
    let pid;
    if (existente.length) {
      pid = existente[0].id;
      const ativo = await api(`atendimento?paciente_id=eq.${pid}&status_id=in.(1,2)&select=numero`);
      if (ativo.length) {
        marcarErro(formRec.elements.cpf, `Paciente já possui o atendimento ${ativo[0].numero} em andamento`);
        formRec.elements.cpf.focus();
        return;
      }
      await api(`paciente?id=eq.${pid}`, { metodo: 'PATCH', corpo: dados });
    } else {
      const novo = await api('paciente', { metodo: 'POST', corpo: dados, retorno: true });
      pid = novo[0].id;
    }
    const criado = await api('atendimento', { metodo: 'POST', corpo: { paciente_id: pid }, retorno: true });
    limparRec();
    const ok = $('#rec-sucesso');
    ok.innerHTML = `Atendimento gerado: <strong>${esc(criado[0].numero)}</strong> — ${esc(d.nome)}. Encaminhar o paciente à triagem.`;
    ok.classList.remove('hidden');
    $('#rec-filtro').value = 'ativos';
    $('#rec-busca').value = '';
    await recarregar();
    render();
  });
}

function editarAtendimento(id) {
  const at = atendPorId(id);
  if (!at || !editavel(at)) { aviso('Este atendimento não pode mais ser alterado', 'erro'); render(); return; }
  const p = pacientePorId(at.pacienteId);
  limparRec();
  $('#rec-sucesso').classList.add('hidden');
  estado.editandoId = id;
  for (const k of ['nome', 'nascimento', 'rg', 'pai', 'mae', 'endereco']) formRec.elements[k].value = p[k] || '';
  formRec.elements.cpf.value = fmtCPF(p.cpf);
  formRec.elements.telefone.value = fmtTel(p.telefone);
  $('#rec-titulo').textContent = `Alterar atendimento ${at.numero}`;
  $('#rec-salvar').textContent = 'Salvar alterações';
  $('#rec-limpar').textContent = 'Cancelar edição';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  formRec.elements.nome.focus();
}

async function cancelarAtendimento(id) {
  const at = atendPorId(id);
  if (!at || !editavel(at)) { aviso('Este atendimento não pode mais ser cancelado', 'erro'); render(); return; }
  const p = pacientePorId(at.pacienteId);
  const r = await confirmar({
    titulo: 'Cancelar atendimento',
    texto: `Cancelar o atendimento ${at.numero} de ${p.nome}? Esta ação não pode ser desfeita.`,
    motivo: true,
    ok: 'Cancelar atendimento',
    perigo: true
  });
  if (!r) return;
  executar(async () => {
    const res = await api(`atendimento?id=eq.${id}&status_id=in.(1,2)`, {
      metodo: 'PATCH',
      corpo: { status_id: 4, data_cancelamento: new Date().toISOString(), motivo_cancelamento: r.motivo || null },
      retorno: true
    });
    if (!res.length) {
      aviso('Este atendimento não pode mais ser cancelado', 'erro');
    } else {
      if (estado.editandoId === id) limparRec();
      if (estado.triagemId === id) fecharTriagem();
      aviso(`Atendimento ${at.numero} cancelado`);
    }
    await recarregar();
    render();
  });
}

function renderRecepcao() {
  const q = $('#rec-busca').value.trim().toLowerCase();
  const qd = digitos(q);
  const f = $('#rec-filtro').value;
  const lista = db.atendimentos.map(comPaciente).filter(a => {
    if (f === 'ativos' && !editavel(a)) return false;
    if (f && f !== 'ativos' && a.status !== f) return false;
    if (!q) return true;
    return a.numero.toLowerCase().includes(q) || (a.paciente.nome || '').toLowerCase().includes(q) || (qd && (a.paciente.cpf || '').includes(qd));
  }).sort((a, b) => b.criadoEm - a.criadoEm);

  const tb = $('#tbl-recepcao tbody');
  if (!lista.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty-row">Nenhum atendimento encontrado.</td></tr>';
    return;
  }
  tb.innerHTML = lista.map(a => {
    const cor = a.triagem ? ` ${badge(a.triagem.classificacao)}` : '';
    const acoes = editavel(a)
      ? `<button class="btn small" data-acao="editar" data-id="${a.id}">Alterar</button>
         <button class="btn small danger-outline" data-acao="cancelar" data-id="${a.id}">Cancelar</button>`
      : '';
    return `<tr>
      <td><strong>${a.numero}</strong></td>
      <td>${esc(a.paciente.nome)}<small>CPF ${fmtCPF(a.paciente.cpf)} · ${idade(a.paciente.nascimento)} anos</small></td>
      <td>${fmtHora(a.criadoEm)}</td>
      <td>${statusTag(a.status)}${cor}</td>
      <td><div class="row-actions"><button class="btn small" data-acao="ver" data-id="${a.id}">Consultar</button>${acoes}</div></td>
    </tr>`;
  }).join('');
}

function itemDL(rotulo, valor, largo = false) {
  return `<div${largo ? ' class="wide"' : ''}><dt>${rotulo}</dt><dd>${esc(valor) || '—'}</dd></div>`;
}

function vitaisHTML(t) {
  return `<div class="vitals">
    <div class="vital"><small>Pressão arterial</small><b>${t.sis}/${t.dia}</b> mmHg</div>
    <div class="vital"><small>Temperatura</small><b>${t.temp.toFixed(1).replace('.', ',')}</b> °C</div>
    <div class="vital"><small>Batimentos</small><b>${t.fc}</b> bpm</div>
    <div class="vital"><small>Classificação</small>${badge(t.classificacao)}</div>
  </div>`;
}

function queixasHTML(t) {
  const tags = t.queixas.map(q => `<span class="tag">${esc(q)}</span>`).join('');
  const outras = t.outras ? `<p class="muted" style="margin:8px 0 0">Obs.: ${esc(t.outras)}</p>` : '';
  return `<div class="tags">${tags}</div>${outras}`;
}

function bannerPaciente(a) {
  const p = a.paciente;
  return `<div class="pb">
    <span class="num">${a.numero}</span>
    <strong>${esc(p.nome)}</strong>
    <span>Nasc. ${fmtData(p.nascimento)} (${idade(p.nascimento)} anos)</span>
    <span>CPF ${fmtCPF(p.cpf)}</span>
    <span>Chegada ${fmtHora(a.criadoEm)}</span>
  </div>`;
}

function abrirDetalhe(id) {
  const base = atendPorId(id);
  if (!base) return;
  const a = comPaciente(base);
  const p = a.paciente;
  let html = `<p>${statusTag(a.status)}</p>
    <div class="sec-title">Paciente</div>
    <dl class="dl">
      ${itemDL('Nome', p.nome, true)}
      ${itemDL('Nascimento', `${fmtData(p.nascimento)} (${idade(p.nascimento)} anos)`)}
      ${itemDL('CPF', fmtCPF(p.cpf))}
      ${itemDL('RG', p.rg)}
      ${itemDL('Mãe', p.mae)}
      ${itemDL('Pai', p.pai)}
      ${itemDL('Telefone', fmtTel(p.telefone))}
      ${itemDL('Endereço', p.endereco, true)}
    </dl>`;

  if (a.triagem) {
    html += `<div class="sec-title">Triagem</div>${vitaisHTML(a.triagem)}${queixasHTML(a.triagem)}`;
  }

  if (a.status === 'confirmado' || a.medicacoes.length) {
    html += `<div class="sec-title">Medicações</div>`;
    if (a.medicacoes.length) {
      html += `<div class="table-wrap"><table><thead><tr><th>Medicamento</th><th>Dose</th><th>Via</th><th>Observação</th></tr></thead><tbody>
        ${a.medicacoes.map(m => `<tr><td>${esc(m.nome)}</td><td>${esc(m.dose)}</td><td>${esc(m.via)}</td><td>${esc(m.obs) || '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
    } else {
      html += '<p class="muted">Nenhuma medicação registrada.</p>';
    }
  }

  if (a.status === 'confirmado') {
    html += `<div class="sec-title">Conclusão</div><dl class="dl">
      ${itemDL('Médico', a.medico)}
      ${itemDL('Confirmado em', fmtDataHora(a.confirmadoEm))}
      ${itemDL('Conduta / observações', a.conduta, true)}
    </dl>`;
  }

  if (a.status === 'cancelado') {
    html += `<div class="sec-title">Cancelamento</div><dl class="dl">
      ${itemDL('Cancelado em', fmtDataHora(a.canceladoEm))}
      ${itemDL('Motivo', a.motivoCancelamento, true)}
    </dl>`;
  }

  $('#dt-titulo').textContent = `Atendimento ${a.numero}`;
  $('#dt-corpo').innerHTML = html;
  $('#dlg-detalhe').showModal();
}

const formTri = $('#form-triagem');

function montarFormTriagem() {
  $('#tri-queixas').innerHTML = QUEIXAS.map(q =>
    `<label class="chip"><input type="checkbox" name="queixa" value="${esc(q)}"><span>${esc(q)}</span></label>`).join('');
  $('#tri-class').innerHTML = Object.entries(MANCHESTER).map(([k, m]) =>
    `<label class="mx cor-${k}"><input type="radio" name="classificacao" value="${k}"><span><b>${m.nome}</b>${m.descricao}<small>${m.meta}</small></span></label>`).join('');
}

function fecharTriagem() {
  estado.triagemId = null;
  formTri.classList.add('hidden');
  $('#triagem-vazio').classList.remove('hidden');
}

function abrirTriagem(id) {
  const base = atendPorId(id);
  if (!base || !editavel(base)) return;
  const a = comPaciente(base);
  estado.triagemId = id;
  formTri.reset();
  limparErros(formTri);
  $('#tri-paciente').innerHTML = bannerPaciente(a);
  if (a.triagem) {
    const t = a.triagem;
    formTri.elements.sis.value = t.sis;
    formTri.elements.dia.value = t.dia;
    formTri.elements.temp.value = t.temp;
    formTri.elements.fc.value = t.fc;
    formTri.elements.outras.value = t.outras || '';
    $$('input[name=queixa]', formTri).forEach(i => { i.checked = t.queixas.includes(i.value); });
    const r = $(`input[name=classificacao][value="${t.classificacao}"]`, formTri);
    if (r) r.checked = true;
  }
  $('#triagem-vazio').classList.add('hidden');
  formTri.classList.remove('hidden');
  renderTriagem();
}

function salvarTriagem(e) {
  e.preventDefault();
  limparErros(formTri);
  const at = atendPorId(estado.triagemId);
  if (!at || !editavel(at)) {
    aviso('Este atendimento não está mais disponível para triagem', 'erro');
    fecharTriagem();
    render();
    return;
  }
  const num = n => formTri.elements[n].value === '' ? NaN : Number(formTri.elements[n].value);
  const sis = num('sis'), dia = num('dia'), temp = num('temp'), fc = num('fc');
  let primeiro = null;
  const falha = (el, msg) => {
    marcarErro(el, msg);
    if (!primeiro) primeiro = el;
  };

  if (!(sis >= 40 && sis <= 300)) falha(formTri.elements.sis, 'Entre 40 e 300');
  if (!(dia >= 20 && dia <= 200)) falha(formTri.elements.dia, 'Entre 20 e 200');
  else if (sis <= dia) falha(formTri.elements.dia, 'Deve ser menor que a sistólica');
  if (!(temp >= 30 && temp <= 45)) falha(formTri.elements.temp, 'Entre 30 e 45');
  if (!(fc >= 20 && fc <= 250)) falha(formTri.elements.fc, 'Entre 20 e 250');

  const queixas = $$('input[name=queixa]:checked', formTri).map(i => i.value);
  const outras = formTri.elements.outras.value.trim();
  if (!queixas.length && !outras) falha($('#tri-queixas'), 'Informe ao menos uma queixa');

  const classificacao = formTri.elements.classificacao.value;
  if (!classificacao) falha($('#tri-class'), 'Selecione a classificação');

  if (primeiro) {
    primeiro.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (primeiro.focus && primeiro.matches('input')) primeiro.focus();
    return;
  }

  const revisao = !!at.triagem;
  executar(async () => {
    const atual = await api(`atendimento?id=eq.${at.id}&select=status_id`);
    if (!atual.length || ![1, 2].includes(atual[0].status_id)) {
      aviso('Este atendimento não está mais disponível para triagem', 'erro');
      fecharTriagem();
      await recarregar();
      render();
      return;
    }
    const corpo = {
      pressao_sistolica: sis,
      pressao_diastolica: dia,
      temperatura: Math.round(temp * 10) / 10,
      batimentos: fc,
      outras_queixas: outras || null,
      classificacao_id: MANCHESTER[classificacao].ordem
    };
    let triagemId;
    if (at.triagem) {
      triagemId = at.triagem.id;
      await api(`triagem?id=eq.${triagemId}`, { metodo: 'PATCH', corpo });
      await api(`triagem_queixa?triagem_id=eq.${triagemId}`, { metodo: 'DELETE' });
    } else {
      const t = await api('triagem', { metodo: 'POST', corpo: { ...corpo, atendimento_id: at.id }, retorno: true });
      triagemId = t[0].id;
    }
    if (queixas.length) {
      await api('triagem_queixa', {
        metodo: 'POST',
        corpo: queixas.map(q => ({ triagem_id: triagemId, queixa_id: catalogo.queixas[q] }))
      });
    }
    await api(`atendimento?id=eq.${at.id}`, { metodo: 'PATCH', corpo: { status_id: 2 } });
    aviso(`${revisao ? 'Triagem atualizada' : 'Triagem registrada'}: ${at.numero} · ${MANCHESTER[classificacao].nome}`);
    fecharTriagem();
    await recarregar();
    render();
  });
}

function renderTriagem() {
  if (estado.triagemId) {
    const at = atendPorId(estado.triagemId);
    if (!at || !editavel(at)) fecharTriagem();
  }
  const fila = db.atendimentos.filter(a => a.status === 'triagem').sort((a, b) => a.criadoEm - b.criadoEm).map(comPaciente);
  const triados = db.atendimentos.filter(a => a.status === 'medico').sort((a, b) => b.criadoEm - a.criadoEm).map(comPaciente);

  const item = a => `<button type="button" class="queue-item cor-${a.triagem ? a.triagem.classificacao : ''} ${a.id === estado.triagemId ? 'sel' : ''}" data-id="${a.id}">
    <span><strong>${a.numero} · ${esc(a.paciente.nome)}</strong><small>${idade(a.paciente.nascimento)} anos${a.triagem ? ' · ' + MANCHESTER[a.triagem.classificacao].descricao : ''}</small></span>
    <span class="wait">${fmtEspera(a.criadoEm)}</span>
  </button>`;

  let html = '<h4>Aguardando triagem</h4>';
  html += fila.length ? fila.map(item).join('') : '<div class="empty">Nenhum paciente aguardando.</div>';
  if (triados.length) {
    html += '<h4>Triados — aguardando médico (revisar)</h4>' + triados.map(item).join('');
  }
  $('#fila-triagem').innerHTML = html;
}

function ordenarPainel() {
  return db.atendimentos.filter(a => a.status === 'medico' && a.triagem)
    .sort((a, b) => MANCHESTER[a.triagem.classificacao].ordem - MANCHESTER[b.triagem.classificacao].ordem || a.criadoEm - b.criadoEm)
    .map(comPaciente);
}

function renderMedico() {
  const emAtendimento = !!estado.medicoId;
  $('#medico-painel').classList.toggle('hidden', emAtendimento);
  $('#medico-atendimento').classList.toggle('hidden', !emAtendimento);
  if (emAtendimento) {
    const at = atendPorId(estado.medicoId);
    if (!at || at.status !== 'medico') { estado.medicoId = null; renderMedico(); return; }
    renderMeds();
    return;
  }
  renderPainel();
}

function renderPainel() {
  $('#painel-hora').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const lista = ordenarPainel();
  const aguardTri = db.atendimentos.filter(a => a.status === 'triagem').length;

  const tiles = Object.entries(MANCHESTER).map(([k, m]) => {
    const n = lista.filter(a => a.triagem.classificacao === k).length;
    return `<div class="tile cor-${k}"><b>${n}</b><small>${m.nome} · ${m.descricao}</small></div>`;
  }).join('') + `<div class="tile"><b>${aguardTri}</b><small>Aguardando triagem</small></div>`;
  $('#painel-resumo').innerHTML = tiles;

  const tb = $('#tbl-painel tbody');
  if (!lista.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty-row">Nenhum paciente aguardando atendimento médico.</td></tr>';
  } else {
    tb.innerHTML = lista.map((a, i) => {
      const t = a.triagem;
      const m = MANCHESTER[t.classificacao];
      const atraso = m.tempo > 0 && minutosDesde(a.criadoEm) > m.tempo;
      const queixas = [...t.queixas, t.outras].filter(Boolean).join(', ');
      return `<tr class="row-color cor-${t.classificacao} ${i === 0 ? 'proximo' : ''}">
        <td class="ordem">${i + 1}º</td>
        <td><strong>${a.numero}</strong></td>
        <td>${esc(a.paciente.nome)}<small>Nasc. ${fmtData(a.paciente.nascimento)} · ${idade(a.paciente.nascimento)} anos</small></td>
        <td>${badge(t.classificacao)}<small>${m.meta}</small></td>
        <td>${esc(queixas)}</td>
        <td>${t.sis}/${t.dia} mmHg<small>${t.temp.toFixed(1).replace('.', ',')} °C · ${t.fc} bpm</small></td>
        <td><span class="espera ${atraso ? 'atraso' : ''}">${fmtEspera(a.criadoEm)}</span>${atraso ? '<small>acima da meta</small>' : ''}</td>
        <td><div class="row-actions">
          <button class="btn small" data-acao="ver" data-id="${a.id}">Detalhes</button>
          <button class="btn small primary" data-acao="atender" data-id="${a.id}">Atender</button>
        </div></td>
      </tr>`;
    }).join('');
  }

  const conf = db.atendimentos.filter(a => a.status === 'confirmado')
    .sort((a, b) => b.confirmadoEm - a.confirmadoEm).map(comPaciente);
  const tc = $('#tbl-confirmados tbody');
  tc.innerHTML = conf.length ? conf.map(a => `<tr>
    <td><strong>${a.numero}</strong></td>
    <td>${esc(a.paciente.nome)}</td>
    <td>${a.triagem ? badge(a.triagem.classificacao) : '—'}</td>
    <td>${esc(a.medico)}</td>
    <td>${fmtDataHora(a.confirmadoEm)}</td>
    <td>${a.medicacoes.length}</td>
    <td><div class="row-actions"><button class="btn small" data-acao="ver" data-id="${a.id}">Consultar</button></div></td>
  </tr>`).join('') : '<tr><td colspan="7" class="empty-row">Nenhum atendimento confirmado.</td></tr>';
}

const formMed = $('#form-med');

function abrirAtendimento(id) {
  const base = atendPorId(id);
  if (!base || base.status !== 'medico') { aviso('Atendimento indisponível', 'erro'); render(); return; }
  const a = comPaciente(base);
  estado.medicoId = id;
  $('#med-titulo').textContent = `Atendimento ${a.numero}`;
  $('#med-resumo').innerHTML = bannerPaciente(a) + vitaisHTML(a.triagem) + queixasHTML(a.triagem);
  formMed.reset();
  limparErros(formMed);
  $('#med-nome').value = a.medico || ultimoMedico();
  $('#med-conduta').value = a.conduta || '';
  $$('.err', $('#medico-atendimento')).forEach(e => e.remove());
  $$('.invalid', $('#medico-atendimento')).forEach(e => e.classList.remove('invalid'));
  renderMedico();
  window.scrollTo(0, 0);
}

function renderMeds() {
  const a = atendPorId(estado.medicoId);
  const tb = $('#tbl-meds tbody');
  if (!a.medicacoes.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty-row">Nenhuma medicação lançada.</td></tr>';
    return;
  }
  tb.innerHTML = a.medicacoes.map(m => `<tr>
    <td><strong>${esc(m.nome)}</strong></td><td>${esc(m.dose)}</td><td>${esc(m.via)}</td><td>${esc(m.obs) || '—'}</td>
    <td><div class="row-actions"><button class="btn small danger-outline" data-acao="remover" data-id="${m.id}">Remover</button></div></td>
  </tr>`).join('');
}

function adicionarMedicacao(e) {
  e.preventDefault();
  limparErros(formMed);
  const a = atendPorId(estado.medicoId);
  if (!a || a.status !== 'medico') return;
  const nome = formMed.elements.nome.value.trim();
  const dose = formMed.elements.dose.value.trim();
  let primeiro = null;
  if (!nome) { marcarErro(formMed.elements.nome, 'Informe o medicamento'); primeiro = formMed.elements.nome; }
  if (!dose) { marcarErro(formMed.elements.dose, 'Informe a dose'); primeiro = primeiro || formMed.elements.dose; }
  if (primeiro) { primeiro.focus(); return; }
  executar(async () => {
    await api('medicacao', {
      metodo: 'POST',
      corpo: {
        atendimento_id: a.id,
        medicamento: nome,
        dose,
        via_id: catalogo.vias[formMed.elements.via.value],
        observacao: formMed.elements.obs.value.trim() || null
      }
    });
    formMed.reset();
    await recarregar();
    renderMedico();
    formMed.elements.nome.focus();
  });
}

async function guardarRascunhoMedico() {
  const a = atendPorId(estado.medicoId);
  if (!a || a.status !== 'medico') return;
  const conduta = $('#med-conduta').value.trim();
  const medico = $('#med-nome').value.trim();
  if (medico) lembrarMedico(medico);
  if (conduta !== a.conduta) {
    a.conduta = conduta;
    try {
      await api(`atendimento?id=eq.${a.id}`, { metodo: 'PATCH', corpo: { conduta: conduta || null } });
    } catch (e) {
      aviso(msgErro(e), 'erro');
    }
  }
}

async function confirmarAtendimento() {
  const a = atendPorId(estado.medicoId);
  if (!a || a.status !== 'medico') { aviso('Atendimento indisponível', 'erro'); render(); return; }
  $$('.err', $('#medico-atendimento')).forEach(e => e.remove());
  $$('.invalid', $('#medico-atendimento')).forEach(e => e.classList.remove('invalid'));
  const medico = $('#med-nome').value.trim();
  if (medico.length < 3) {
    marcarErro($('#med-nome'), 'Informe o médico responsável');
    $('#med-nome').focus();
    return;
  }
  if (formMed.elements.nome.value.trim() || formMed.elements.dose.value.trim()) {
    marcarErro(formMed.elements.nome, 'Clique em Adicionar para lançar esta medicação');
    formMed.elements.nome.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const p = pacientePorId(a.pacienteId);
  const r = await confirmar({
    titulo: 'Confirmar atendimento',
    texto: `Confirmar o atendimento ${a.numero} de ${p.nome}? Depois disso ele não poderá mais ser alterado nem cancelado pela recepção.`,
    ok: 'Confirmar atendimento'
  });
  if (!r) return;
  const conduta = $('#med-conduta').value.trim();
  executar(async () => {
    const achado = await api(`medico?nome=eq.${encodeURIComponent(medico)}&select=id`);
    const medicoId = achado.length
      ? achado[0].id
      : (await api('medico', { metodo: 'POST', corpo: { nome: medico }, retorno: true }))[0].id;
    const res = await api(`atendimento?id=eq.${a.id}&status_id=eq.2`, {
      metodo: 'PATCH',
      corpo: { status_id: 3, medico_id: medicoId, data_confirmacao: new Date().toISOString(), conduta: conduta || null },
      retorno: true
    });
    if (!res.length) {
      aviso('Atendimento indisponível', 'erro');
    } else {
      lembrarMedico(medico);
      estado.medicoId = null;
      aviso(`Atendimento ${a.numero} confirmado`);
    }
    await recarregar();
    render();
  });
}





async function iniciar() {
  $('#tbl-recepcao tbody').innerHTML = '<tr><td colspan="5" class="empty-row">Carregando dados do banco…</td></tr>';

  $$('.tab').forEach(b => b.addEventListener('click', () => irPara(b.dataset.view)));

  formRec.addEventListener('submit', salvarRecepcao);
  formRec.elements.cpf.addEventListener('input', e => {
    e.target.value = fmtCPF(e.target.value);
    if (!estado.editandoId && digitos(e.target.value).length === 11) preencherPorCPF();
    else if (!estado.editandoId) $('#rec-aviso').classList.add('hidden');
  });
  formRec.elements.telefone.addEventListener('input', e => { e.target.value = fmtTel(e.target.value); });
  $('#rec-limpar').addEventListener('click', limparRec);
  $('#rec-busca').addEventListener('input', renderRecepcao);
  $('#rec-filtro').addEventListener('change', renderRecepcao);

  $('#tbl-recepcao tbody').addEventListener('click', e => {
    const b = e.target.closest('button[data-acao]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.acao === 'ver') abrirDetalhe(id);
    else if (b.dataset.acao === 'editar') editarAtendimento(id);
    else if (b.dataset.acao === 'cancelar') cancelarAtendimento(id);
  });

  $('#fila-triagem').addEventListener('click', e => {
    const b = e.target.closest('.queue-item');
    if (b) abrirTriagem(Number(b.dataset.id));
  });
  formTri.addEventListener('submit', salvarTriagem);
  $('#tri-fechar').addEventListener('click', () => { fecharTriagem(); renderTriagem(); });

  const aoClicarMedico = e => {
    const b = e.target.closest('button[data-acao]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.acao === 'ver') abrirDetalhe(id);
    else if (b.dataset.acao === 'atender') abrirAtendimento(id);
  };
  $('#tbl-painel tbody').addEventListener('click', aoClicarMedico);
  $('#tbl-confirmados tbody').addEventListener('click', aoClicarMedico);
  $('#med-voltar').addEventListener('click', async () => { await guardarRascunhoMedico(); estado.medicoId = null; render(); });
  formMed.addEventListener('submit', adicionarMedicacao);
  $('#tbl-meds tbody').addEventListener('click', e => {
    const b = e.target.closest('button[data-acao="remover"]');
    if (!b) return;
    executar(async () => {
      await api(`medicacao?id=eq.${Number(b.dataset.id)}`, { metodo: 'DELETE' });
      await recarregar();
      renderMedico();
    });
  });
  $('#med-conduta').addEventListener('change', guardarRascunhoMedico);
  $('#med-nome').addEventListener('change', guardarRascunhoMedico);
  $('#med-confirmar').addEventListener('click', confirmarAtendimento);

  $('#dt-fechar').addEventListener('click', () => $('#dlg-detalhe').close());
  $('#dlg-detalhe').addEventListener('click', e => { if (e.target.id === 'dlg-detalhe') e.target.close(); });

  try {
    await carregarCatalogo();
    montarFormTriagem();
    formMed.elements.via.innerHTML = VIAS.map(v => `<option>${esc(v)}</option>`).join('');
    await recarregar();
  } catch (e) {
    aviso('Não foi possível conectar ao banco de dados', 'erro');
  }
  render();

  setInterval(async () => {
    if (document.hidden || gravando) return;
    try {
      await recarregar();
      render();
    } catch (e) {}
  }, 20000);
}

iniciar();
