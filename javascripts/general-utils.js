/********************************************************

Common library for jshell utilities

(c) Kalid Azad 2006
http://www.jshell.com
********************************************************/

///////////////////////////////////////////////////////////////
/// UTILITY FUNCTIONS: Show/Hide item, clear CSS style, etc.
///////////////////////////////////////////////////////////////
	function hideItem(itemName)
	{	
		var i = document.getElementById(itemName);
		i.style.display = "none";
	}
	
	function showItem(itemName)
	{	
		var i = document.getElementById(itemName);
		i.style.display = "";
	}
	
	function toggleItem(itemName)
	{
		var i = document.getElementById(itemName);
		if (i.style.display=="none"){
			//fade in the item
			new Effect.Highlight(i)
		
			i.style.display = "";
		}
		else{
			i.style.display ="none";
		}
	}
	
	function clearItem(itemName){
		var i = document.getElementById(itemName);
		i.innerHTML = "";
	}
	
	function hideAll(){

	}
	
  function changeCSS(id, newClass) {
	var identity=document.getElementById(id);
	identity.className=newClass;
  }

function setFont(element,size){
   var i = document.getElementById(element)
   i.style.display = ParseInt(size)
}

function toggle(i){ // only toggle integeres
  if (i == 1)
    i = 0
  else if (i == 0)
     i = 1
  return i
}

// return all URL parameters in a hash array (key => value)
// TODO
function getURLParams(){
	var strReturn;
	var strHref = window.location.href;
	
	return strReturn;

}

function getURLParam(strParamName){
	var strReturn = "";
	var strHref = window.location.href;
	if ( strHref.indexOf("?") > -1 ){
		var strQueryString = strHref.substr(strHref.indexOf("?"));
		var aQueryString = strQueryString.split("&");
		for ( var iParam = 0; iParam < aQueryString.length; iParam++ ){
			if (aQueryString[iParam].indexOf(strParamName + "=") > -1 ){
				var aParam = aQueryString[iParam].split("=");
				strReturn = aParam[1];
				break;
			}
		}
	}
	
	return strReturn;
}

function getURLNoParams(){
	var strHref = window.location.href;

	if ( strHref.indexOf("?") > -1 ){
		var a = strHref.split("?");
		strHref = a[0];
	}
	return strHref;
}