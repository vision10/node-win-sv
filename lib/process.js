const cmd = require('./cmd');

module.exports = {
  start: function (serviceName) {
    return cmd.execute('net', `start "${serviceName}"`)
  },
  stop: function (serviceName) {
    return cmd.execute('net', `stop "${serviceName}"`)
  },
  restart: function (serviceName) {
    return cmd.execute(`net stop "${serviceName}" && net start "${serviceName}"`)
  },
  kill: function (pidOrName, filter, force) {
    filter = filter ? `/FI "${filter}"` : '';
    const pid = `${typeof pidOrName == 'number' ? '/PID' : '/IM'} ${pidOrName || '*'}`
    return cmd.execute(`taskkill ${pid} ${filter} ${(force === true ? '/f' : '')}`);
  },
  list: function (filter, verbose) {
    if (filter) {
      filter = ` | ${(filter instanceof RegExp ? 'findstr' : 'find /i')} "${filter}"`
    }
    return cmd.execute(`tasklist /FO CSV ${(verbose === true ? '/V' : '')} ${(filter || '')}`).then(function (data) {
      var result = [], head = null;
      var p = data.split('\r\n');

      while (p.length > 1) {
        var rec = p.shift();
        rec = rec.replace(/\"\,/gi, '";').replace(/\"|\'/gi, '').split(';');
        if (head == null) {
          head = rec;
          for (var i = 0; i < head.length; i++) {
            head[i] = head[i].replace(/ /gi, '')
          }
        } else {
          var tmp = {};
          for (var i = 0; i < rec.length; i++) {
            tmp[head[i]] = rec[i].replace(/\"|\'/gi, '')
          }
          result.push(tmp)
        }
      }
      return result
    })
  },
}